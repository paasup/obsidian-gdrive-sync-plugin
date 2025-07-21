/*
 * Obsidian Google Drive Sync Plugin
 * Copyright (c) 2024 PAASUP
 * 
 * Dual License:
 * - Open Source: MIT License (see LICENSE-MIT.txt)
 * - Commercial: Commercial License (see LICENSE-COMMERCIAL.txt)
 * 
 */

import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, requestUrl, FuzzySuggestModal, Modal, TextComponent  } from 'obsidian';

interface GDriveSyncSettings {
    clientId: string;
    clientSecret: string;
    apiKey: string;
    syncFolders: string[]; // Google Drive 폴더 ID들
    syncWholeVault: boolean;
    autoSync: boolean;
    syncInterval: number;
    accessToken: string;
    refreshToken: string; 
    tokenExpiresAt: number;
    driveFolder: string;
    includeSubfolders: boolean;
    // syncMode: 'etag' | 'always' | 'modified' | 'checksum';
    lastSyncTime: number;
    syncDirection: 'upload' | 'download' | 'bidirectional';
    conflictResolution: 'local' | 'remote' | 'newer' | 'ask';
    createMissingFolders: boolean;
    selectedDriveFolders: Array<{id: string, name: string, path: string}>; // 선택된 Google Drive 폴더 정보
    fileStateCache: {[filePath: string]: FileState};
}
// 🔥 간소화된 파일 상태 인터페이스
interface FileState {
    localModTime?: number;       // 로컬 파일 수정 시간 (밀리초)
    remoteHash?: string;         // 원격 파일 md5Checksum
    remoteModTime?: number;      // 원격 파일 수정 시간
    lastSyncTime?: number;       // 마지막 동기화 시간
    version?: string;            // Google Drive version 필드
}

const DEFAULT_SETTINGS: GDriveSyncSettings = {
    clientId: '',
    clientSecret: '',
    apiKey: '',
    syncFolders: [],
    syncWholeVault: false,
    autoSync: false,
    syncInterval: 300000,
    accessToken: '',
    refreshToken: '',
    tokenExpiresAt: 0,
    driveFolder: 'Obsidian-Sync',
    includeSubfolders: true,
    // syncMode: 'etag',
    lastSyncTime: 0,
    syncDirection: 'bidirectional',
    conflictResolution: 'newer',
    createMissingFolders: true,
    selectedDriveFolders: [],
    fileStateCache: {} 
};

// 동기화 결과 인터페이스
interface SyncResult {
    uploaded: number;
    downloaded: number;
    skipped: number;
    conflicts: number;
    errors: number;
    createdFolders: string[];
}

// Google Drive 폴더 인터페이스
interface DriveFolder {
    id: string;
    name: string;
    path: string;
    mimeType: string;
    parents?: string[];
}
interface FolderListItem extends DriveFolder {
    isSelected: boolean;     // 현재 동기화 대상 여부
    canSelect: boolean;      // 선택 가능 여부
}

// 진행상태 모달
class SyncProgressModal extends Modal {
    private progressBar: HTMLElement;
    private progressEl: HTMLElement;
    private statusEl: HTMLElement;
    private logEl: HTMLElement;
    private cancelButton: HTMLButtonElement;
    private closeButton: HTMLButtonElement;
    private isCancelled = false;
    private isCompleted = false;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // 제목
        contentEl.createEl('h2', { text: 'Google Drive Sync Progress' });

        // 진행률 바
        const progressContainer = contentEl.createEl('div', {
            attr: { 
                style: 'background: var(--background-modifier-border); border-radius: 4px; height: 16px; margin: 15px 0; overflow: hidden;' 
            }
        });

        this.progressBar = progressContainer.createEl('div', {
            attr: { 
                style: 'background: var(--interactive-accent); height: 100%; width: 0%; transition: width 0.3s ease;' 
            }
        });

        // 진행률 텍스트
        this.progressEl = contentEl.createEl('div', { 
            text: 'Preparing...',
            attr: { style: 'text-align: center; margin-bottom: 15px; font-weight: 500;' }
        });

        // 현재 상태
        this.statusEl = contentEl.createEl('div', { 
            text: 'Initializing sync...',
            attr: { 
                style: 'padding: 10px; background: var(--background-secondary); border-radius: 4px; margin-bottom: 15px;' 
            }
        });

        // 로그 영역
        this.logEl = contentEl.createEl('div', {
            attr: { 
                style: 'max-height: 150px; overflow-y: auto; background: var(--background-primary-alt); padding: 8px; border-radius: 4px; font-family: var(--font-monospace); font-size: 11px; margin-bottom: 15px; border: 1px solid var(--background-modifier-border);' 
            }
        });

        // 버튼들
        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'display: flex; justify-content: flex-end; gap: 10px;' }
        });

        this.cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel',
            cls: 'mod-warning'
        });
        
        this.closeButton = buttonContainer.createEl('button', { 
            text: 'Close',
            cls: 'mod-cta'
        });
        this.closeButton.style.display = 'none';

        // 이벤트 핸들러
        this.cancelButton.onclick = () => {
            if (!this.isCompleted) {
                this.isCancelled = true;
                this.updateStatus('Cancelling sync...');
                this.cancelButton.disabled = true;
                this.cancelButton.textContent = 'Cancelling...';
            }
        };

        this.closeButton.onclick = () => this.close();
    }

    updateProgress(current: number, total: number, operation: string = '') {
        if (this.isCancelled) return;

        const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
        this.progressBar.style.width = `${percentage}%`;
        this.progressEl.textContent = `${percentage}% (${current}/${total})`;
        
        if (operation) {
            this.updateStatus(operation);
        }
    }

    updateStatus(message: string) {
        if (this.isCancelled && !message.includes('Cancel')) return;
        this.statusEl.textContent = message;
    }

    addLog(message: string) {
        if (this.isCancelled && !message.includes('cancel')) return;
    
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        
        const logLine = this.logEl.createEl('div', { 
            text: logEntry,
            attr: { style: 'margin-bottom: 2px;' }
        });
        
        // 자동 스크롤
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    markCompleted(result: SyncResult) {
        this.isCompleted = true;
        this.progressBar.style.width = '100%';
        this.progressEl.textContent = '100% - Completed';

        // 결과 요약
        const hasErrors = result.errors > 0;
        const summary = [
            `${result.uploaded} uploaded`,
            `${result.downloaded} downloaded`,
            `${result.skipped} skipped`,
            result.conflicts > 0 ? `${result.conflicts} conflicts` : '',
            result.errors > 0 ? `${result.errors} errors` : ''
        ].filter(Boolean).join(', ');

        this.updateStatus(`${hasErrors ? '⚠️' : '✅'} Sync completed: ${summary}`);
        
        // 상세 결과 로그
        this.addLog('=== SYNC COMPLETED ===');
        this.addLog(`📤 Uploaded: ${result.uploaded} files`);
        this.addLog(`📥 Downloaded: ${result.downloaded} files`);
        this.addLog(`⏭️ Skipped: ${result.skipped} files`);
        if (result.conflicts > 0) this.addLog(`⚡ Conflicts resolved: ${result.conflicts}`);
        if (result.errors > 0) this.addLog(`❌ Errors: ${result.errors}`);
        if (result.createdFolders.length > 0) {
            this.addLog(`📁 Created ${result.createdFolders.length} folders`);
        }

        // 버튼 상태 변경
        this.cancelButton.style.display = 'none';
        this.closeButton.style.display = 'inline-block';
    }

    markCancelled() {
        this.isCancelled = true;
        this.updateStatus('🛑 Sync cancelled by user');
        this.addLog('Sync operation cancelled by user');
        
        this.cancelButton.style.display = 'none';
        this.closeButton.style.display = 'inline-block';
        this.closeButton.textContent = 'Close';
    }

    shouldCancel(): boolean {
        return this.isCancelled;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}


// Google Drive 폴더 선택 모달
// 기본 UI를 사용하는 Google Drive 폴더 선택 모달
class DriveFolderModal extends Modal {
    private plugin: GDriveSyncPlugin;
    private onChoose: (folder: DriveFolder) => void;
    private folders: DriveFolder[] = [];
    private folderListEl: HTMLElement;
    
    constructor(app: App, plugin: GDriveSyncPlugin, onChoose: (folder: DriveFolder) => void) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
    
        contentEl.createEl('h2', { text: 'Select Google Drive Folder' });
        
        // 로딩 상태
        const loadingEl = contentEl.createEl('div', { 
            text: 'Loading Google Drive folders...',
            attr: { style: 'text-align: center; padding: 20px; color: var(--text-muted);' }
        });
        
        try {
            await this.loadDriveFolders();
            loadingEl.remove();
            this.renderFolderList(contentEl);
        } catch (error) {
            loadingEl.textContent = 'Failed to load folders. Please check your authentication.';
            loadingEl.style.color = 'var(--text-error)';
            console.error('Error loading Drive folders:', error);
        }
    
        // 버튼 영역
        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'display: flex; justify-content: space-between; margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--background-modifier-border);' }
        });
    
        // 왼쪽 버튼들
        const leftButtons = buttonContainer.createEl('div', {
            attr: { style: 'display: flex; gap: 10px;' }
        });

        const createFolderBtn = leftButtons.createEl('button', { 
            text: 'Create New Folder',
            cls: 'mod-cta'
        });
        createFolderBtn.onclick = () => this.showCreateFolderDialog();
    
        const refreshBtn = leftButtons.createEl('button', { 
            text: 'Refresh'
        });
        refreshBtn.onclick = () => this.refreshFolders();
    
        // 오른쪽 버튼
        const cancelBtn = buttonContainer.createEl('button', { 
            text: 'Cancel'
        });
        cancelBtn.onclick = () => this.close();
    }

    private renderFolderList(container: HTMLElement) {
        // 폴더 목록 컨테이너
        this.folderListEl = container.createEl('div', { 
            attr: { 
                style: 'max-height: 400px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin: 15px 0;' 
            }
        });
    
        const folderListItems = this.createFolderListItems();
    
        if (folderListItems.length === 0) {
            const emptyState = this.folderListEl.createEl('div', { 
                text: 'No folders found in Google Drive.',
                attr: { style: 'text-align: center; padding: 40px; color: var(--text-muted);' }
            });
            return;
        }
    
        // 폴더 상태별 정렬
        const sortedFolders = folderListItems.sort((a, b) => {
            if (a.isSelected && !b.isSelected) return -1;
            if (!a.isSelected && b.isSelected) return 1;
            return a.name.localeCompare(b.name);
        });
    
        sortedFolders.forEach(folderItem => {
            this.renderFolderItem(this.folderListEl, folderItem);
        });
    }

    private createFolderListItems(): FolderListItem[] {
        const selectedFolderIds = new Set(
            this.plugin.settings.selectedDriveFolders.map(f => f.id)
        );
    
        return this.folders.map(folder => ({
            ...folder,
            isSelected: selectedFolderIds.has(folder.id),
            canSelect: !selectedFolderIds.has(folder.id)
        }));
    }
    
    private renderFolderItem(container: HTMLElement, folderItem: FolderListItem) {
        const itemEl = container.createEl('div', { 
            attr: { 
                style: `
                    display: flex; 
                    align-items: center; 
                    padding: 12px; 
                    border-bottom: 1px solid var(--background-modifier-border); 
                    transition: background 0.2s ease;
                    ${folderItem.isSelected ? 'background: var(--background-modifier-hover);' : ''}
                ` 
            }
        });
    
        // 호버 효과
        itemEl.addEventListener('mouseenter', () => {
            if (!folderItem.isSelected) {
                itemEl.style.backgroundColor = 'var(--background-modifier-hover)';
            }
        });
        itemEl.addEventListener('mouseleave', () => {
            if (!folderItem.isSelected) {
                itemEl.style.backgroundColor = 'transparent';
            }
        });
    
        // 폴더 아이콘
        const folderIcon = itemEl.createEl('span', { 
            text: folderItem.isSelected ? '✅' : '📁',
            attr: { style: 'margin-right: 12px; font-size: 16px;' }
        });
    
        // 폴더 정보
        const folderInfo = itemEl.createEl('div', { 
            attr: { style: 'flex-grow: 1; min-width: 0;' }
        });
        
        const nameEl = folderInfo.createEl('div', { 
            text: folderItem.name,
            attr: { 
                style: `
                    font-weight: ${folderItem.isSelected ? 'bold' : 'normal'}; 
                    color: ${folderItem.isSelected ? 'var(--text-accent)' : 'var(--text-normal)'};
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                ` 
            }
        });
        
        const pathEl = folderInfo.createEl('small', { 
            text: `Path: ${folderItem.path || '/'}`,
            attr: { 
                style: 'color: var(--text-muted); font-size: 0.8em; display: block; margin-top: 2px;' 
            }
        });
    
        // 액션 버튼들
        const buttonContainer = itemEl.createEl('div', {
            attr: { style: 'display: flex; gap: 8px;' }
        });
    
        if (folderItem.isSelected) {
            // 이미 선택된 폴더
            const selectedBtn = buttonContainer.createEl('button', { 
                text: 'Selected',
                attr: { 
                    style: 'padding: 4px 8px; font-size: 11px; opacity: 0.7;',
                    disabled: 'true'
                }
            });
    
            const removeBtn = buttonContainer.createEl('button', { 
                text: 'Remove',
                cls: 'mod-warning',
                attr: { style: 'padding: 4px 8px; font-size: 11px;' }
            });
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                this.onRemoveFolder(folderItem);
            };
    
        } else {
            // 미선택 폴더
            const selectBtn = buttonContainer.createEl('button', { 
                text: 'Select',
                cls: 'mod-cta',
                attr: { style: 'padding: 4px 8px; font-size: 11px;' }
            });
            selectBtn.onclick = (e) => {
                e.stopPropagation();
                this.onSelectFolder(folderItem);
            };
    
            // 삭제 버튼
            const deleteBtn = buttonContainer.createEl('button', { 
                text: '🗑️',
                cls: 'mod-warning',
                attr: { 
                    style: 'padding: 4px 6px; font-size: 11px;',
                    title: 'Delete from Google Drive'
                }
            });
            deleteBtn.onclick = async (e) => {
                e.stopPropagation();
                const success = await this.deleteDriveFolder(folderItem.id, folderItem.name);
                if (success) {
                    await this.loadDriveFolders();
                    this.refreshFolderList();
                }
            };
        }
    }

    private async onSelectFolder(folderItem: FolderListItem): Promise<void> {
        try {
            // 설정에 추가
            this.plugin.settings.selectedDriveFolders.push({
                id: folderItem.id,
                name: folderItem.name,
                path: folderItem.path
            });
    
            await this.plugin.saveSettings();
            
            // UI 새로고침
            this.refreshFolderList();
            this.plugin.notifySettingsChanged();

            new Notice(`✅ Added folder: ${folderItem.name}`);
            
        } catch (error) {
            console.error('Error selecting folder:', error);
            new Notice(`❌ Failed to add folder: ${folderItem.name}`);
        }
    }
    
    private async onRemoveFolder(folderItem: FolderListItem): Promise<void> {
        try {
            // 설정에서 제거
            this.plugin.settings.selectedDriveFolders = this.plugin.settings.selectedDriveFolders
                .filter(f => f.id !== folderItem.id);
    
            await this.plugin.saveSettings();
            
            // UI 새로고침
            this.refreshFolderList();
            this.plugin.notifySettingsChanged();

            new Notice(`✅ Removed folder: ${folderItem.name}`);
            
        } catch (error) {
            console.error('Error removing folder:', error);
            new Notice(`❌ Failed to remove folder: ${folderItem.name}`);
        }
    }

    private refreshFolderList(): void {
        if (this.folderListEl) {
            this.folderListEl.empty();
            const folderListItems = this.createFolderListItems();
            
            if (folderListItems.length === 0) {
                this.folderListEl.createEl('div', { 
                    text: 'No folders found in Google Drive.',
                    attr: { style: 'text-align: center; padding: 40px; color: var(--text-muted);' }
                });
                return;
            }

            const sortedFolders = folderListItems.sort((a, b) => {
                if (a.isSelected && !b.isSelected) return -1;
                if (!a.isSelected && b.isSelected) return 1;
                return a.name.localeCompare(b.name);
            });

            sortedFolders.forEach(folderItem => {
                this.renderFolderItem(this.folderListEl, folderItem);
            });
        }
    }
    
    private async refreshFolders(): Promise<void> {
        try {
            const loadingEl = this.folderListEl.createEl('div', {
                text: 'Refreshing...',
                attr: { style: 'text-align: center; padding: 20px; color: var(--text-muted);' }
            });
    
            await this.loadDriveFolders();
            loadingEl.remove();
            this.refreshFolderList();
    
            new Notice('✅ Folder list refreshed');
        } catch (error) {
            console.error('Error refreshing folders:', error);
            new Notice('❌ Failed to refresh folders');
        }
    }

    private async loadDriveFolders() {
        try {
            const rootFolder = await this.plugin.getOrCreateDriveFolder();
            if (!rootFolder) {
                throw new Error('Failed to access root folder');
            }

            this.folders = await this.getAllDriveFoldersRecursive(rootFolder.id, '');
            
            console.log('Loaded folders:', this.folders);
        } catch (error) {
            console.error('Error loading Drive folders:', error);
            throw error;
        }
    }

    private async getAllDriveFoldersRecursive(folderId: string, basePath: string): Promise<DriveFolder[]> {
        const folders: DriveFolder[] = [];
        
        try {
            const query = `'${folderId}' in parents and (mimeType='application/vnd.google-apps.folder') and trashed=false`;
            
            const params = new URLSearchParams({
                q: query,
                fields: 'files(id,name,mimeType,parents)',
                pageSize: '1000',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true'
            });
            
            const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
            
            const response = await this.plugin.makeAuthenticatedRequest(url, { method: 'GET' });
    
            if (response.status === 200) {
                const data = response.json;
                
                for (const item of data.files || []) {
                    const itemPath = basePath ? `${basePath}/${item.name}` : item.name;
                    
                    let driveFolder: DriveFolder;
                    
                  
                    driveFolder = {
                        id: item.id,
                        name: item.name,
                        path: itemPath,
                        mimeType: item.mimeType,
                        parents: item.parents
                    };
               
                    
                    folders.push(driveFolder);
                }
            }
        } catch (error) {
            console.error('Error loading folders:', error);
        }
    
        return folders;
    }


    private async deleteDriveFolder(folderId: string, folderName: string): Promise<boolean> {
        try {
            console.log(`Attempting to delete folder: ${folderName} (${folderId})`);
            
            const confirmDelete = confirm(`Are you sure you want to delete the folder "${folderName}" from Google Drive?\n\nThis action cannot be undone and will move the folder to trash.`);
            
            if (!confirmDelete) {
                console.log('Folder deletion cancelled by user');
                return false;
            }
    
            const response = await this.plugin.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files/${folderId}`,
                { method: 'DELETE' }
            );
    
            if (response.status === 204 || response.status === 200) {
                console.log(`✓ Successfully deleted folder: ${folderName}`);
                new Notice(`✅ Folder "${folderName}" moved to trash`);
                return true;
            } else {
                console.error('Failed to delete folder:', response.status, response.json);
                new Notice(`❌ Failed to delete folder "${folderName}"`);
                return false;
            }
    
        } catch (error) {
            console.error('Error deleting folder:', error);
            new Notice(`❌ Error deleting folder "${folderName}"`);
            return false;
        }
    }

    private async showCreateFolderDialog() {
        const createModal = new CreateFolderModal(this.app, async (folderName: string) => {
            try {
                const rootFolder = await this.plugin.getOrCreateDriveFolder();
                if (!rootFolder) {
                    new Notice('❌ Failed to access root folder');
                    return;
                }
    
                const newFolder = await this.createDriveFolder(folderName, rootFolder.id);
                if (newFolder) {
                    new Notice(`✅ Created folder: ${folderName}`);
                    await this.refreshFolders();
                }
            } catch (error) {
                console.error('Error creating folder:', error);
                new Notice('❌ Failed to create folder');
            }
        });
        
        createModal.open();
    }

    private async createDriveFolder(name: string, parentId: string): Promise<DriveFolder | null> {
        try {
            const response = await this.plugin.makeAuthenticatedRequest(
                'https://www.googleapis.com/drive/v3/files',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [parentId]
                    })
                }
            );

            if (response.status === 200 || response.status === 201) {
                const folderData = response.json;
                return {
                    id: folderData.id,
                    name: folderData.name,
                    path: folderData.name,
                    mimeType: folderData.mimeType,
                    parents: folderData.parents
                };
            }
        } catch (error) {
            console.error('Error creating Drive folder:', error);
        }
        return null;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 폴더 생성 모달도 기본 UI로 변경
class CreateFolderModal extends Modal {
    private onSubmit: (folderName: string) => void;

    constructor(app: App, onSubmit: (folderName: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Create New Google Drive Folder' });

        const inputContainer = contentEl.createEl('div', { 
            attr: { style: 'margin: 20px 0;' }
        });

        const inputLabel = inputContainer.createEl('label', { 
            text: 'Folder Name:',
            attr: { style: 'display: block; margin-bottom: 8px; font-weight: bold;' }
        });

        const folderInput = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'Enter folder name...',
            attr: { 
                style: 'width: 100%; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 4px;'
            }
        });

        folderInput.focus();

        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--background-modifier-border);' }
        });

        const createButton = buttonContainer.createEl('button', { 
            text: 'Create Folder',
            cls: 'mod-cta'
        });

        const cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel'
        });

        const handleSubmit = () => {
            const folderName = folderInput.value.trim();
            if (!folderName) {
                new Notice('❌ Please enter a folder name');
                folderInput.focus();
                return;
            }

            if (!/^[^<>:"/\\|?*]+$/.test(folderName)) {
                new Notice('❌ Invalid folder name. Please avoid special characters: < > : " / \\ | ? *');
                folderInput.focus();
                return;
            }

            this.onSubmit(folderName);
            this.close();
        };

        createButton.onclick = handleSubmit;
        cancelButton.onclick = () => this.close();

        folderInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 충돌 해결 모달
class ConflictResolutionModal extends Modal {
    private localFile: TFile;
    private remoteFile: any;
    private onResolve: (resolution: 'local' | 'remote') => void;

    constructor(app: App, localFile: TFile, remoteFile: any, onResolve: (resolution: 'local' | 'remote') => void) {
        super(app);
        this.localFile = localFile;
        this.remoteFile = remoteFile;
        this.onResolve = onResolve;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Sync Conflict Resolution' });
        
        const conflictInfo = contentEl.createEl('div', { 
            attr: { style: 'margin: 20px 0;' }
        });
        
        conflictInfo.createEl('p', { text: `File: ${this.localFile.path}` });
        
        const localTime = new Date(this.localFile.stat.mtime).toLocaleString();
        const remoteTime = new Date(this.remoteFile.modifiedTime).toLocaleString();
        
        conflictInfo.innerHTML += `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0;">
                <div style="padding: 15px; border: 1px solid var(--background-modifier-border); border-radius: 5px;">
                    <h3>📱 Local File</h3>
                    <p><strong>Modified:</strong> ${localTime}</p>
                    <p><strong>Size:</strong> ${this.localFile.stat.size} bytes</p>
                </div>
                <div style="padding: 15px; border: 1px solid var(--background-modifier-border); border-radius: 5px;">
                    <h3>☁️ Remote File</h3>
                    <p><strong>Modified:</strong> ${remoteTime}</p>
                    <p><strong>Size:</strong> ${this.remoteFile.size || 'Unknown'} bytes</p>
                </div>
            </div>
        `;

        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'text-align: center; margin-top: 20px;' }
        });

        const useLocalButton = buttonContainer.createEl('button', { 
            text: 'Use Local File',
            cls: 'mod-cta',
            attr: { style: 'margin-right: 10px;' }
        });
        useLocalButton.onclick = () => {
            this.onResolve('local');
            this.close();
        };

        const useRemoteButton = buttonContainer.createEl('button', { 
            text: 'Use Remote File',
            cls: 'mod-cta',
            attr: { style: 'margin-right: 10px;' }
        });
        useRemoteButton.onclick = () => {
            this.onResolve('remote');
            this.close();
        };

        const cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel'
        });
        cancelButton.onclick = () => this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 폴더 캐시 인터페이스
interface FolderCache {
    [folderPath: string]: string; // folderPath -> folderId 매핑
}

export default class GDriveSyncPlugin extends Plugin {
    settings: GDriveSyncSettings;
    syncIntervalId: number | null = null;
    public isGoogleApiLoaded = false;
    private folderCache: FolderCache = {};
    public settingTab: GDriveSyncSettingTab | null = null;

    public notifySettingsChanged(): void {
        if (this.settingTab) {
            setTimeout(() => {
                this.settingTab?.refreshDisplay();
            }, 50);
        }
    }

    // 🔥 파일 상태 캐시 관리 메서드들
    private getFileState(filePath: string): FileState {
        return this.settings.fileStateCache[filePath] || {};
    }

    private setFileState(filePath: string, state: Partial<FileState>): void {
        if (!this.settings.fileStateCache[filePath]) {
            this.settings.fileStateCache[filePath] = {};
        }
        Object.assign(this.settings.fileStateCache[filePath], state);
    }

    public clearFileStateCache(): void {
        this.settings.fileStateCache = {};
        this.settings.selectedDriveFolders = [];
        this.folderCache = {};        
        this.saveSettings();
        console.log('🧹 File state cache cleared');
        new Notice('✅ File state cache cleared');
    }

    // 폴더 캐시 초기화 메서드
    private clearFolderCache(): void {
        this.folderCache = {};
        // ETag 캐시는 유지 (파일 동기화에 필요)
        console.log('📁 Folder cache cleared (ETag cache preserved)');
    }

    async refreshAccessToken(): Promise<boolean> {
        if (!this.settings.refreshToken) {
            console.log('No refresh token available');
            return false;
        }
    
        try {
            console.log('Refreshing access token...');
            
            const response = await requestUrl({
                url: 'https://oauth2.googleapis.com/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id: this.settings.clientId,
                    client_secret: this.settings.clientSecret,
                    refresh_token: this.settings.refreshToken,
                    grant_type: 'refresh_token'
                }).toString(),
                throw: false
            });
    
            if (response.status === 200) {
                const tokenData = response.json;
                console.log('Token refresh successful');
                
                this.settings.accessToken = tokenData.access_token;
                
                // 새로운 refresh token이 있으면 업데이트 (선택사항)
                if (tokenData.refresh_token) {
                    this.settings.refreshToken = tokenData.refresh_token;
                }
                
                // 토큰 만료 시간 설정 (현재 시간 + expires_in 초)
                const expiresIn = tokenData.expires_in || 3600; // 기본 1시간
                this.settings.tokenExpiresAt = Date.now() + (expiresIn * 1000);
                
                console.log('🧹 Clearing selectedDriveFolders due to new authentication');
                this.settings.selectedDriveFolders = [];

                await this.saveSettings();
                
                console.log(`✓ Access token refreshed, expires at: ${new Date(this.settings.tokenExpiresAt).toLocaleString()}`);
                return true;
            } else {
                console.error('Token refresh failed:', response.status, response.json);
                
                // Refresh token이 만료된 경우
                if (response.status === 400 || response.status === 401) {
                    console.log('Refresh token expired, need to re-authenticate');
                    this.settings.accessToken = '';
                    this.settings.refreshToken = '';
                    this.settings.tokenExpiresAt = 0;
                    await this.saveSettings();
                    
                    new Notice('🔄 Login expired. Please authenticate again.');
                }
                
                return false;
            }
        } catch (error) {
            console.error('Token refresh error:', error);
            return false;
        }
    }

    async ensureValidToken(): Promise<boolean> {
        // 토큰이 없으면 인증 필요
        if (!this.settings.accessToken) {
            console.log('No access token available');
            return false;
        }
    
        // Refresh token이 없으면 재인증 필요
        if (!this.settings.refreshToken) {
            console.log('No refresh token available - need to re-authenticate');
            return false;
        }
    
        // 토큰 만료 시간이 설정되어 있고, 만료 5분 전이면 갱신
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;
        
        if (this.settings.tokenExpiresAt > 0 && 
            now >= (this.settings.tokenExpiresAt - fiveMinutes)) {
            
            console.log('Access token will expire soon, refreshing...');
            return await this.refreshAccessToken();
        }
    
        // 토큰 만료 시간이 설정되지 않았거나 아직 유효한 경우
        return true;
    }   

    // 캐시된 폴더 ID 가져오기 또는 생성
    private async getCachedFolderId(folderPath: string, rootFolderId: string): Promise<string> {
        // 캐시에서 먼저 확인
        if (this.folderCache[folderPath]) {
            console.log(`🚀 Using cached folder ID for: ${folderPath}`);
            return this.folderCache[folderPath];
        }

        // 캐시에 없으면 생성하고 캐시에 저장
        console.log(`🔍 Creating/finding folder structure: ${folderPath}`);
        const folderId = await this.createNestedFolders(folderPath, rootFolderId);
        
        if (folderId) {
            this.folderCache[folderPath] = folderId;
            console.log(`💾 Cached folder ID for: ${folderPath} -> ${folderId}`);
        }
        
        return folderId;
    }

    async onload() {
        await this.loadSettings();
    
        const ribbonIconEl = this.addRibbonIcon('cloud', 'Google Drive Sync', (evt) => {
            this.mainSync(true); 
        });
        ribbonIconEl.addClass('gdrive-sync-ribbon-class');
        
        // 🔥 NEW: 상태바 아이템 추가
        this.addStatusBarSync();
        
        // 🔥 NEW: 파일 메뉴에 동기화 옵션 추가
        this.addFileMenuItems();

        // 🔥 NEW: 폴더 우클릭 메뉴 - 조건부 표시
        this.addFolderContextMenu();

        // Commands 추가
        this.addCommand({
            id: 'sync-with-gdrive',
            name: 'Sync with Google Drive',
            callback: () => {
                this.mainSync(false); // 🔥 수정
            }
        });
    
        this.addCommand({
            id: 'download-from-gdrive',
            name: 'Download from Google Drive',
            callback: () => {
                this.downloadFromGoogleDrive(false);
            }
        });
    
        this.addCommand({
            id: 'upload-to-gdrive',
            name: 'Upload to Google Drive',
            callback: () => {
                this.uploadToGoogleDrive(false);
            }
        });
    
        // Auto Sync 디버그 명령어 추가
        this.addCommand({
            id: 'debug-auto-sync',
            name: 'Debug Auto Sync Status',
            callback: () => {
                this.debugAutoSyncStatus();
            }
        });

        // 단축키 추가
        this.addCommand({
            id: 'quick-sync-gdrive',
            name: 'Quick Sync with Google Drive',
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'S' }], // Ctrl+Shift+S
            callback: () => {
                this.mainSync(true); // 진행률 표시와 함께
            }
        });

        // 현재 파일만 동기화
        this.addCommand({
            id: 'sync-current-file',
            name: 'Sync Current File to Google Drive',
            editorCallback: (editor, view) => {
                const file = view.file;
                if (file) {
                    this.syncSingleFile(file);
                } else {
                    new Notice('No active file to sync');
                }
            }
        });
    
        // 파일 변경 감지 및 자동 동기화 설정
        this.setupFileChangeDetection();

        this.settingTab = new GDriveSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);
    
        console.log('Plugin loaded - Google Drive folder-based sync');
        console.log(`Initial auto sync setting: ${this.settings.autoSync}`);
    
        // Auto Sync 초기 설정
        if (this.settings.autoSync) {
            console.log('Initializing auto sync on plugin load...');
            this.setupAutoSync();
        } else {
            console.log('Auto sync disabled on plugin load');
        }
    }
  
    // 파일 변경 감지 설정
    private setupFileChangeDetection(): void {
        // 파일 수정 감지
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && this.shouldSyncFileType(file)) {
                    this.handleFileModification(file);
                }
            })
        );

        // 파일 생성 감지
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file instanceof TFile && this.shouldSyncFileType(file)) {
                    this.handleFileModification(file);
                }
            })
        );

        // 파일 삭제 감지 (향후 기능)
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) {
                    console.log(`File deleted: ${file.path}`);
                    // 향후 Google Drive에서도 삭제하는 기능 추가 가능
                }
            })
        );
    }

    // 파일 수정 처리
    private async handleFileModification(file: TFile): Promise<void> {
        if (!this.isAuthenticated() || !this.settings.autoSync) {
            return;
        }

        // 파일이 동기화 대상인지 확인
        let isInSyncFolder = false;
        if (this.settings.syncWholeVault) {
            isInSyncFolder = true;
        } else {
            const fileFolder = file.parent?.path || '';
            isInSyncFolder = this.isFolderSelectedForSync(fileFolder);
        }

        if (!isInSyncFolder) {
            return;
        }

        console.log(`🔄 File modified and will be auto-synced: ${file.path}`);
        
        // 5초 후 자동 동기화 (디바운싱)
        if (this.autoSyncTimeout) {
            clearTimeout(this.autoSyncTimeout);
        }

        this.autoSyncTimeout = window.setTimeout(async () => {
            try {
                console.log(`🚀 Auto-syncing modified file: ${file.path}`);
                await this.syncSingleFile(file);
            } catch (error) {
                console.error('Auto-sync error:', error);
            }
        }, 5000);
    }

    private autoSyncTimeout: number | null = null;
  
    // 🔥 상태바에 동기화 상태 표시
    private addStatusBarSync(): void {
        const statusBarItemEl = this.addStatusBarItem();
        
        const updateStatusBar = () => {
            const activeFile = this.app.workspace.getActiveFile();
            const isAuth = this.isAuthenticated();
            const isAutoSync = this.isAutoSyncActive();
            const lastSync = this.settings.lastSyncTime;
            
            // 현재 파일이 동기화 대상인지 확인
            let showStatusBar = false;
            let canSyncCurrentFile = false;
            
            if (activeFile && this.shouldSyncFileType(activeFile)) {
                if (this.settings.syncWholeVault) {
                    showStatusBar = true;
                    canSyncCurrentFile = true;
                } else {
                    const fileFolder = activeFile.parent?.path || '';
                    if (this.isFolderSelectedForSync(fileFolder)) {
                        showStatusBar = true;
                        canSyncCurrentFile = true;
                    }
                }
            }
            
            // 상태바 표시/숨김
            statusBarItemEl.style.display = showStatusBar ? 'block' : 'none';
            
            if (!showStatusBar) return;
            
            // 통합 아이콘 및 타이틀 설정
            let iconText = '';
            let title = '';
            let shouldAnimate = false;

            if (!isAuth) {
                iconText = '🌫️'; // 회색 구름 (인증 안됨)
                title = 'Google Drive: Not authenticated';
            } else if (isAutoSync && canSyncCurrentFile) {
                iconText = '🌀'; // 회전하는 구름 (자동 동기화 활성)
                title = `Google Drive: Sync Current File (Auto-sync: ${this.settings.syncInterval / 60000}min)`;
                shouldAnimate = true;
            } else if (canSyncCurrentFile) {
                iconText = '☁️'; // 일반 구름 (동기화 준비됨)
                title = 'Google Drive: Sync Current File';
            }
            
            if (lastSync > 0 && canSyncCurrentFile) {
                const timeSince = Date.now() - lastSync;
                const minutesAgo = Math.floor(timeSince / 60000);
                if (minutesAgo < 60) {
                    title += ` - Last sync: ${minutesAgo}min ago`;
                } else {
                    title += ` - Last sync: ${new Date(lastSync).toLocaleTimeString()}`;
                }
            }
            
            statusBarItemEl.empty();
            const iconEl = statusBarItemEl.createEl('span', { 
                text: iconText,
                cls: 'gdrive-status-icon'
            });
            iconEl.title = title;
            
            // CSS 애니메이션 적용 (자동 동기화 활성 시)
            if (shouldAnimate) {
                iconEl.classList.add('gdrive-auto-sync-active');
            } else {
                iconEl.classList.remove('gdrive-auto-sync-active');
            }
        };
        
        // 🔥 UPDATE: 클릭하면 현재 파일 동기화
        statusBarItemEl.onclick = () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && this.shouldSyncFileType(activeFile)) {
                this.syncSingleFile(activeFile);
            } else if (activeFile) {
                new Notice('❌ Current file type is not supported for sync');
            } else {
                new Notice('❌ No active file to sync');
            }
        };
        
        // 정기적으로 상태 업데이트
        updateStatusBar();
        this.registerInterval(window.setInterval(updateStatusBar, 5000)); // 5초마다 업데이트
        
        // 파일 변경 시에도 업데이트
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            setTimeout(updateStatusBar, 100); // 약간의 지연 후 업데이트
        }));
        this.registerEvent(this.app.workspace.on('file-open', () => {
            setTimeout(updateStatusBar, 100);
        }));
        
        // CSS 애니메이션 추가
        this.addStatusBarCSS();
    }

    private addStatusBarCSS(): void {
        const style = document.createElement('style');
        style.textContent = `
        .gdrive-status-icon {
            cursor: pointer;
            transition: all 0.2s ease;
            display: inline-block;
            font-size: 14px;
        }
        
        .gdrive-status-icon:hover {
            transform: scale(1.2);
            filter: brightness(1.2);
        }
        
        .gdrive-status-icon:active {
            transform: scale(0.9);
        }
        
        .gdrive-status-icon.gdrive-auto-sync-active {
            animation: gdrive-pulse 2s ease-in-out infinite;
        }
        
        @keyframes gdrive-pulse {
            0% { 
                opacity: 1; 
                transform: scale(1);
            }
            50% { 
                opacity: 0.6; 
                transform: scale(1.1);
            }
            100% { 
                opacity: 1; 
                transform: scale(1);
            }
        }
        
        /* 더 부드러운 회전 애니메이션 대안 */
        @keyframes gdrive-rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .gdrive-status-icon.gdrive-rotating {
            animation: gdrive-rotate 3s linear infinite;
        }
        `;
        document.head.appendChild(style);
    }
    
    // 🔥 파일 메뉴에 동기화 옵션 추가
    private addFileMenuItems(): void {
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (file instanceof TFile && this.shouldSyncFileType(file)) {
                    menu.addItem((item) => {
                        item
                            .setTitle('Sync to Google Drive')
                            .setIcon('cloud')
                            .onClick(async () => {
                                await this.syncSingleFile(file);
                            });
                    });
                }
            })
        );
    }

    // 🔥 폴더 우클릭 메뉴에 동기화 옵션 추가
    private addFolderContextMenu(): void {
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (file instanceof TFolder) {
                    const folderPath = file.path;
                    const isSelectedForSync = this.isFolderSelectedForSync(folderPath);
                    const isSyncWholeVault = this.settings.syncWholeVault;
                    
                    if (isSyncWholeVault) {
                        // 전체 볼트 동기화 모드인 경우 - 폴더 동기화 메뉴
                        menu.addItem((item) => {
                            item
                                .setTitle('Sync Folder to Google Drive')
                                .setIcon('cloud')
                                .onClick(async () => {
                                    await this.syncFolderToGoogleDrive(file);
                                });
                        });
                    } else if (isSelectedForSync) {
                        // 이미 동기화 대상인 경우 - 폴더 동기화 메뉴
                        menu.addItem((item) => {
                            item
                                .setTitle('Sync Folder to Google Drive')
                                .setIcon('cloud')
                                .onClick(async () => {
                                    await this.syncFolderToGoogleDrive(file);
                                });
                        });
                        
                        // 동기화 대상에서 제거 메뉴
                        // menu.addItem((item) => {
                        //     item
                        //         .setTitle('❌ Remove from Sync Targets')
                        //         .setIcon('x')
                        //         .onClick(async () => {
                        //             await this.removeFolderFromSyncTargets(folderPath);
                        //         });
                        // });
                    } else {
                        // 동기화 대상이 아닌 경우 - 동기화 대상 등록 메뉴
                        menu.addItem((item) => {
                            item
                                .setTitle('Add to Google Drive Sync')
                                .setIcon('plus')
                                .onClick(async () => {
                                    await this.addFolderToSyncTargets(file);
                                });
                        });
                    }
                }
            })
        );
    }

    // 🔥 단일 파일 동기화 메서드
    private async syncSingleFile(file: TFile): Promise<void> {
        try {
            if (!this.isAuthenticated()) {
                new Notice('❌ Please authenticate with Google Drive first');
                return;
            }
    
            new Notice(`🔄 Syncing ${file.name}...`);
    
            // 상태바 아이콘을 일시적으로 회전 애니메이션 적용
            const statusIcon = document.querySelector('.gdrive-status-icon') as HTMLElement;
            if (statusIcon) {
                statusIcon.classList.add('gdrive-rotating');
            }
    
            // 🔥 기존 양방향 동기화 로직 재사용
            let result: SyncResult;
            let driveFile: any = null;
    
            if (this.settings.syncWholeVault) {
                // 전체 볼트 동기화 모드
                const rootFolder = await this.getOrCreateDriveFolder();
                if (!rootFolder) {
                    new Notice('❌ Failed to access Google Drive folder');
                    return;
                }
    
                // Google Drive에서 해당 파일 찾기
                let relativePath = file.path;
                let fileName = file.name;
                let targetFolderId = rootFolder.id;
                
                if (relativePath.includes('/')) {
                    const pathParts = relativePath.split('/');
                    fileName = pathParts.pop()!;
                    const folderPath = pathParts.join('/');
                    targetFolderId = await this.getCachedFolderId(folderPath, rootFolder.id);
                }
                
                driveFile = await this.findFileInDrive(fileName, targetFolderId);
    
                // 양방향 동기화 수행
                result = await this.performBidirectionalSyncWithGlobalProgress(
                    [file], // 단일 파일 배열
                    driveFile ? [{ ...driveFile, path: file.path }] : [], // 원격 파일이 있으면 배열로
                    rootFolder.id,
                    '', // baseFolder는 빈 문자열
                    undefined, // progressModal 없음
                    0,
                    1
                );
            } else {
                // 선택된 폴더 동기화 모드
                const fileFolder = file.parent?.path || '';
                const selectedFolder = this.settings.selectedDriveFolders.find(
                    sf => fileFolder === sf.path || fileFolder.startsWith(sf.path + '/')
                );
                
                if (!selectedFolder) {
                    new Notice(`❌ File "${file.name}" is not in a configured sync folder`);
                    return;
                }
    
                // Google Drive에서 해당 파일 찾기
                const relativePath = this.getRelativePath(file.path, selectedFolder.path);
                let fileName = file.name;
                let targetFolderId = selectedFolder.id;
                
                if (relativePath.includes('/')) {
                    const pathParts = relativePath.split('/');
                    fileName = pathParts.pop()!;
                    const folderPath = pathParts.join('/');
                    
                    // 중첩 폴더 처리
                    if (folderPath) {
                        targetFolderId = await this.getCachedFolderId(folderPath, selectedFolder.id);
                    }
                }
                
                driveFile = await this.findFileInDrive(fileName, targetFolderId);
    
                // 양방향 동기화 수행
                result = await this.performBidirectionalSyncWithGlobalProgress(
                    [file], // 단일 파일 배열
                    driveFile ? [{ ...driveFile, path: file.path }] : [], // 원격 파일이 있으면 배열로
                    selectedFolder.id,
                    selectedFolder.path,
                    undefined, // progressModal 없음
                    0,
                    1
                );
            }
            
            // 애니메이션 제거
            if (statusIcon) {
                statusIcon.classList.remove('gdrive-rotating');
            }
    
            // 🔥 결과에 따른 알림
            if (result.downloaded > 0) {
                new Notice(`📥 ${file.name} downloaded from Google Drive`);
            } else if (result.uploaded > 0) {
                new Notice(`📤 ${file.name} uploaded to Google Drive`);
            } else if (result.conflicts > 0) {
                new Notice(`⚡ ${file.name} conflict resolved`);
            } else if (result.skipped > 0) {
                new Notice(`⏭️ ${file.name} is already up to date`);
            } else if (result.errors > 0) {
                new Notice(`❌ Failed to sync ${file.name}`);
            } else {
                new Notice(`✅ ${file.name} synced successfully`);
            }
    
            // 🔥 마지막 동기화 시간 업데이트
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();
    
        } catch (error) {
            console.error('Single file sync error:', error);
            new Notice(`❌ Error syncing ${file.name}: ${error.message}`);
    
            // 에러 시에도 애니메이션 제거
            const statusIcon = document.querySelector('.gdrive-status-icon') as HTMLElement;
            if (statusIcon) {
                statusIcon.classList.remove('gdrive-rotating');
            }
        }
    }

    // 🔥 NEW: 폴더가 동기화 대상인지 확인
    private isFolderSelectedForSync(folderPath: string): boolean {
        if (!folderPath) return this.settings.syncWholeVault; // 루트 폴더인 경우
        
        return this.settings.selectedDriveFolders.some(folder => {
            // 정확히 일치하거나 하위 폴더인 경우
            return folderPath === folder.path || 
                   folderPath.startsWith(folder.path + '/') ||
                   folder.path.startsWith(folderPath + '/'); // 상위 폴더도 포함
        });
    }

    // 🔥 NEW: 폴더를 동기화 대상에 추가
    private async addFolderToSyncTargets(folder: TFolder): Promise<void> {
        try {
            if (!this.isAuthenticated()) {
                new Notice('❌ Please authenticate with Google Drive first');
                return;
            }

            // Google Drive에서 같은 이름의 폴더 찾기 또는 생성
            const rootFolder = await this.getOrCreateDriveFolder();
            if (!rootFolder) {
                new Notice('❌ Failed to access Google Drive folder');
                return;
            }

            // Google Drive에 폴더 생성 또는 찾기
            let driveFolder = await this.findFolderInDrive(folder.name, rootFolder.id);
            
            if (!driveFolder) {
                // 폴더가 없으면 생성
                driveFolder = await this.createFolderInDrive(folder.name, rootFolder.id);
                if (!driveFolder) {
                    new Notice(`❌ Failed to create folder "${folder.name}" in Google Drive`);
                    return;
                }
            }

            // 동기화 대상에 추가
            this.settings.selectedDriveFolders.push({
                id: driveFolder.id,
                name: driveFolder.name,
                path: folder.path
            });

            await this.saveSettings();
            new Notice(`✅ Added "${folder.name}" to sync targets`);
            
            // 설정 탭 새로고침
            this.notifySettingsChanged();

        } catch (error) {
            console.error('Error adding folder to sync targets:', error);
            new Notice(`❌ Error adding folder: ${error.message}`);
        }
    }

    // 🔥 NEW: 폴더를 동기화 대상에서 제거
    private async removeFolderFromSyncTargets(folderPath: string): Promise<void> {
        try {
            const folderIndex = this.settings.selectedDriveFolders.findIndex(folder => 
                folder.path === folderPath
            );
            
            if (folderIndex !== -1) {
                const folderName = this.settings.selectedDriveFolders[folderIndex].name;
                this.settings.selectedDriveFolders.splice(folderIndex, 1);
                await this.saveSettings();
                
                new Notice(`✅ Removed "${folderName}" from sync targets`);
                
                // 설정 탭 새로고침
                this.notifySettingsChanged();
            } else {
                new Notice('❌ Folder not found in sync targets');
            }

        } catch (error) {
            console.error('Error removing folder from sync targets:', error);
            new Notice(`❌ Error removing folder: ${error.message}`);
        }
    }    
    
    // 🔥 폴더 동기화 메서드
    private async syncFolderToGoogleDrive(folder: TFolder): Promise<void> {
        try {
            if (!this.isAuthenticated()) {
                new Notice('❌ Please authenticate with Google Drive first');
                return;
            }
    
            const files = await this.collectFilesToSync(folder, true);
            if (files.length === 0) {
                new Notice(`📁 No syncable files found in ${folder.name}`);
                return;
            }
    
            new Notice(`🔄 Syncing ${files.length} files from ${folder.name}...`);
    
            // 🔥 기존 양방향 동기화 로직 재사용
            let result: SyncResult;
            
            if (this.settings.syncWholeVault) {
                // 전체 볼트 동기화 모드인 경우 - 기존 bidirectionalSync 사용
                const rootFolder = await this.getOrCreateDriveFolder();
                if (!rootFolder) {
                    new Notice('❌ Failed to access Google Drive folder');
                    return;
                }
    
                // 해당 폴더의 파일들만 필터링해서 동기화
                const allLocalFiles = this.app.vault.getFiles().filter(file => this.shouldSyncFileType(file));
                const folderFiles = allLocalFiles.filter(file => 
                    file.path.startsWith(folder.path + '/') || file.path === folder.path
                );
                
                const allDriveFiles = await this.getAllFilesFromDrive(rootFolder.id);
                const folderDriveFiles = allDriveFiles.filter(file => 
                    file.path.startsWith(folder.path + '/') || file.path === folder.path
                );
    
                result = await this.performBidirectionalSyncWithGlobalProgress(
                    folderFiles, 
                    folderDriveFiles, 
                    rootFolder.id, 
                    '', // baseFolder는 빈 문자열 (전체 볼트 모드)
                    undefined, // progressModal 없음
                    0, 
                    folderFiles.length + folderDriveFiles.length
                );
            } else {
                // 선택된 폴더 동기화 모드인 경우
                const selectedFolder = this.settings.selectedDriveFolders.find(
                    sf => sf.path === folder.path
                );
                
                if (!selectedFolder) {
                    new Notice(`❌ Folder "${folder.name}" is not configured for sync. Please add it in settings.`);
                    return;
                }
    
                const localFiles = await this.getLocalFilesForDriveFolder(selectedFolder);
                const driveFiles = await this.getAllFilesFromDrive(selectedFolder.id, selectedFolder.path);
    
                result = await this.performBidirectionalSyncWithGlobalProgress(
                    localFiles, 
                    driveFiles, 
                    selectedFolder.id, 
                    selectedFolder.path,
                    undefined, // progressModal 없음
                    0, 
                    localFiles.length + driveFiles.length
                );
            }
    
            // 🔥 기존과 동일한 결과 요약 로직
            const messages: string[] = [];
            if (result.uploaded > 0) messages.push(`${result.uploaded} uploaded`);
            if (result.downloaded > 0) messages.push(`${result.downloaded} downloaded`);
            if (result.skipped > 0) messages.push(`${result.skipped} skipped`);
            if (result.conflicts > 0) messages.push(`${result.conflicts} conflicts resolved`);
            
            const summary = messages.length > 0 ? messages.join(', ') : 'No changes';
            
            if (result.errors === 0) {
                new Notice(`✅ Folder sync completed: ${summary}`);
            } else {
                new Notice(`⚠️ Folder sync completed with ${result.errors} errors: ${summary}`);
            }
    
            // 🔥 마지막 동기화 시간 업데이트
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();
    
        } catch (error) {
            console.error('Folder sync error:', error);
            new Notice(`❌ Error syncing folder ${folder.name}: ${error.message}`);
        }
    }

    debugAutoSyncStatus() {
        const debugInfo = {
            autoSyncSetting: this.settings.autoSync,
            syncIntervalId: this.syncIntervalId,
            isAutoSyncActive: this.isAutoSyncActive(),
            syncInterval: this.settings.syncInterval,
            syncIntervalMinutes: this.settings.syncInterval / 60000,
            currentTime: new Date().toLocaleString(),
            lastSyncTime: this.settings.lastSyncTime > 0 ? new Date(this.settings.lastSyncTime).toLocaleString() : 'Never'
        };

        console.log('=== AUTO SYNC DEBUG INFO ===');
        console.table(debugInfo);
        
        new Notice(`Auto Sync: ${this.isAutoSyncActive() ? '✅ Active' : '❌ Inactive'} (Check console for details)`);
        
        return debugInfo;
    }

   // onunload에서 정리
   onunload() {
        console.log('Unloading plugin...');
        this.stopAutoSync();
        
        // 🔥 NEW: 자동 동기화 타이머 정리
        if (this.autoSyncTimeout) {
            clearTimeout(this.autoSyncTimeout);
            this.autoSyncTimeout = null;
        }
        
        console.log('Plugin unloaded');
    }   

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        
        // 기존 데이터 마이그레이션
        const oldData = await this.loadData();
        if (oldData && oldData.syncFolder && !oldData.syncFolders) {
            this.settings.syncFolders = [oldData.syncFolder];
            await this.saveSettings();
        }
    }

    public isAutoSyncActive(): boolean {
        return this.settings.autoSync && this.syncIntervalId !== null;
    }

    async saveSettings() {
        console.log(`Saving settings... Auto sync: ${this.settings.autoSync}`);
        await this.saveData(this.settings);
        
        // 설정 변경 후 Auto Sync 상태 재동기화
        if (this.settings.autoSync && !this.isAutoSyncActive()) {
            console.log('Auto sync enabled but not active - setting up...');
            this.setupAutoSync();
        } else if (!this.settings.autoSync && this.isAutoSyncActive()) {
            console.log('Auto sync disabled but still active - stopping...');
            this.stopAutoSync();
        }
    }

    stopAutoSync() {
        console.log('=== Stopping Auto Sync ===');
        if (this.syncIntervalId) {
            console.log(`Clearing interval: ${this.syncIntervalId}`);
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
            console.log('✅ Auto sync stopped');
        } else {
            console.log('ℹ️ No auto sync interval to clear');
        }
    }
    // 인증 관련 메서드들
    async authenticateGoogleDrive(): Promise<boolean> {
        console.log('=== Starting Google Drive Desktop Authentication ===');
        
        if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.apiKey) {
            console.error('Missing credentials');
            new Notice('❌ Please set Client ID, Client Secret, and API Key in settings first.');
            return false;
        }

        console.log('✓ Credentials are set');

        const authUrl = this.generateAuthUrl();
        
        new Notice('Opening browser for Desktop App authentication...');
        console.log('Desktop Auth URL:', authUrl);
        
        try {
            window.open(authUrl, '_blank');
            
            new Notice('🔗 Complete authentication in browser, then copy the authorization code and use "Authorization Code" input in settings.');
            
            return false;
        } catch (error) {
            console.error('Failed to open browser:', error);
            
            try {
                navigator.clipboard.writeText(authUrl);
                new Notice('📋 Auth URL copied to clipboard. Open it in your browser.');
            } catch (clipboardError) {
                console.error('Failed to copy to clipboard:', clipboardError);
                new Notice('❌ Failed to open browser. Please check console for auth URL.');
            }
            
            return false;
        }
    }

    private generateAuthUrl(): string {
        const params = new URLSearchParams({
            client_id: this.settings.clientId,
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
            scope: 'https://www.googleapis.com/auth/drive',
            response_type: 'code',
            access_type: 'offline',
            prompt: 'consent'
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    async exchangeCodeForToken(authCode: string): Promise<boolean> {
        try {
            console.log('Exchanging authorization code for tokens...');
            
            const response = await requestUrl({
                url: 'https://oauth2.googleapis.com/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id: this.settings.clientId,
                    client_secret: this.settings.clientSecret,
                    code: authCode,
                    grant_type: 'authorization_code',
                    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob'
                }).toString(),
                throw: false
            });

            if (response.status === 200) {
                const tokenData = response.json;
                console.log('Token exchange successful');
                
                // Access token과 refresh token 저장
                this.settings.accessToken = tokenData.access_token;
                this.settings.refreshToken = tokenData.refresh_token; // 중요!
                
                // 토큰 만료 시간 계산
                const expiresIn = tokenData.expires_in || 3600; // 기본 1시간
                this.settings.tokenExpiresAt = Date.now() + (expiresIn * 1000);
                
                await this.saveSettings();
                
                console.log(`✓ Tokens saved successfully`);
                console.log(`  Access token expires at: ${new Date(this.settings.tokenExpiresAt).toLocaleString()}`);
                console.log(`  Refresh token available: ${!!this.settings.refreshToken}`);
                
                new Notice('✅ Authentication successful! Tokens saved for long-term use.');
                return true;
            } else {
                console.error('Token exchange failed:', response.status, response.json);
                new Notice('❌ Failed to exchange authorization code for tokens.');
                return false;
            }
        } catch (error) {
            console.error('Token exchange error:', error);
            new Notice('❌ Token exchange failed. Check console for details.');
            return false;
        }
    }

    async revokeGoogleDriveAccess(): Promise<boolean> {
        try {
            console.log('Revoking Google Drive access...');
    
            if (this.settings.refreshToken) {
                try {
                    // Google에 토큰 무효화 요청
                    await requestUrl({
                        url: `https://oauth2.googleapis.com/revoke?token=${this.settings.refreshToken}`,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        throw: false
                    });
                    console.log('✓ Tokens revoked from Google');
                } catch (error) {
                    console.warn('Failed to revoke tokens from Google:', error);
                }
            }
    
            // 로컬에서 토큰 제거
            this.settings.accessToken = '';
            this.settings.refreshToken = '';
            this.settings.tokenExpiresAt = 0;
            await this.saveSettings();
    
            console.log('✓ Google Drive access revoked successfully');
            new Notice('Google Drive access revoked successfully');
            
            // 🔥 설정 화면 즉시 업데이트
            this.triggerSettingsRefresh();
            
            return true;
    
        } catch (error) {
            console.error('Failed to revoke access:', error);
            new Notice('Failed to revoke access. Tokens cleared locally.');
            
            // 에러가 발생해도 로컬 토큰은 제거
            this.settings.accessToken = '';
            this.settings.refreshToken = '';
            this.settings.tokenExpiresAt = 0;
            await this.saveSettings();
            
            // 🔥 설정 화면 즉시 업데이트
            this.triggerSettingsRefresh();
            
            return false;
        }
    }
    private triggerSettingsRefresh(): void {
        // 설정 탭이 열려있는지 확인하고 새로고침
        const settingsModal = document.querySelector('.modal.mod-settings');
        if (settingsModal) {
            // 현재 열린 설정 탭 찾기
            const pluginSettings = settingsModal.querySelector('.setting-tab-content');
            if (pluginSettings) {
                // 설정 탭 새로고침 이벤트 발생
                setTimeout(() => {
                    // 설정 탭 인스턴스에 접근하여 display() 메서드 호출
                    const app = this.app as any;
                    if (app.setting && app.setting.activeTab && app.setting.activeTab.plugin === this) {
                        app.setting.activeTab.display();
                    }
                }, 100);
            }
        }
        if (this.settingTab) {
            // 100ms 후 설정 탭 새로고침
            setTimeout(() => {
                this.settingTab?.display();
            }, 100);
        }
    }
    isAuthenticated(): boolean {
        return !!(this.settings.accessToken && this.settings.refreshToken);
    }

    // API 호출 전에 토큰 검증을 추가하는 헬퍼 메서드
    async makeAuthenticatedRequest(url: string, options: any = {}): Promise<any> {
        let retryCount = 0;
        const maxRetries = 2;
    
        while (retryCount <= maxRetries) {
            try {
                // 토큰 유효성 확인 및 자동 갱신
                const tokenValid = await this.ensureValidToken();
                if (!tokenValid) {
                    throw new Error('Authentication failed. Please sign in again.');
                }
    
                // 기본 헤더에 Authorization 추가
                const headers = {
                    'Authorization': `Bearer ${this.settings.accessToken}`,
                    ...options.headers
                };
    
                const response = await requestUrl({
                    ...options,
                    url,
                    headers,
                    throw: false
                });
    
                // 401 에러인 경우 토큰 갱신 후 재시도
                if (response.status === 401 && retryCount < maxRetries) {
                    console.log(`🔄 Token expired during request, attempting refresh (retry ${retryCount + 1}/${maxRetries})`);
                    
                    const refreshed = await this.refreshAccessToken();
                    if (!refreshed) {
                        throw new Error('Failed to refresh access token. Please sign in again.');
                    }
                    
                    retryCount++;
                    continue; // 재시도
                }
    
                // 403 에러인 경우 (API 할당량 초과 등)
                if (response.status === 403) {
                    const errorData = response.json || {};
                    if (errorData.error?.message?.includes('quota')) {
                        throw new Error('Google Drive API quota exceeded. Please try again later.');
                    }
                }
    
                return response;
    
            } catch (error) {
                if (retryCount >= maxRetries) {
                    console.error(`❌ Request failed after ${maxRetries} retries:`, error);
                    throw error;
                }
                
                retryCount++;
                console.log(`⚠️ Request failed, retrying (${retryCount}/${maxRetries}):`, error.message);
                
                // 재시도 전 잠시 대기
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }
    
        throw new Error('Request failed after all retries');
    }

    private getRelativePath(filePath: string, baseFolder: string): string {
        if (!baseFolder) return filePath;
        
        if (filePath.startsWith(baseFolder + '/')) {
            return filePath.substring(baseFolder.length + 1);
        } else if (filePath === baseFolder) {
            return '';
        }
        
        return filePath;
    }

    private async performBidirectionalSyncWithGlobalProgress(
        localFiles: TFile[], 
        driveFiles: any[], 
        rootFolderId: string, 
        baseFolder: string,
        progressModal?: SyncProgressModal,
        startingProgress: number = 0,
        totalFiles: number = 0
    ): Promise<SyncResult> {
        const result = this.createEmptyResult();
        
        // 파일 매핑 생성
        const localFileMap = new Map<string, TFile>();
        localFiles.forEach(file => {
            const relativePath = this.getRelativePath(file.path, baseFolder);
            localFileMap.set(relativePath, file);
        });
    
        const driveFileMap = new Map<string, any>();
        driveFiles.forEach(file => {
            const relativePath = this.getRelativePath(file.path, baseFolder);
            driveFileMap.set(relativePath, file);
        });
    
        const allPaths = new Set([...localFileMap.keys(), ...driveFileMap.keys()]);
        let processedInThisFolder = 0;
    
        for (const filePath of allPaths) {
            if (progressModal?.shouldCancel()) {
                return result;
            }
    
            const localFile = localFileMap.get(filePath);
            const driveFile = driveFileMap.get(filePath);
    
            try {
                // 🔥 전체 진행률 업데이트 (시작 지점 + 현재 폴더 내 진행률)
                const globalProgress = startingProgress + processedInThisFolder;
                progressModal?.updateProgress(globalProgress, totalFiles, `Processing: ${filePath}`);
    
                if (localFile && driveFile) {
                    progressModal?.addLog(`🔍 Checking: ${filePath}`);
                    
                    const syncResult = await this.resolveFileConflictSafe(localFile, driveFile, rootFolderId, baseFolder);
                    
                    switch (syncResult.action) {
                        case 'uploaded':
                            result.uploaded++;
                            result.conflicts++;
                            progressModal?.addLog(`⚡ Conflict resolved (uploaded): ${filePath}`);
                            break;
                        case 'downloaded':
                            result.downloaded++;
                            result.conflicts++;
                            progressModal?.addLog(`⚡ Conflict resolved (downloaded): ${filePath}`);
                            break;
                        case 'skipped':
                            result.skipped++;
                            break;
                        case 'error':
                            result.errors++;
                            progressModal?.addLog(`❌ Error processing: ${filePath} - ${syncResult.error}`);
                            break;
                    }
                } else if (localFile && !driveFile) {
                    progressModal?.addLog(`📤 Upload: ${filePath}`);
                    const uploadResult = await this.uploadSingleFileSafe(localFile, rootFolderId, baseFolder);
                    if (uploadResult.success) {
                        result.uploaded++;
                    } else {
                        result.errors++;
                        progressModal?.addLog(`❌ Upload failed: ${filePath} - ${uploadResult.error}`);
                    }
                } else if (!localFile && driveFile) {
                    progressModal?.addLog(`📥 Download: ${filePath}`);
                    const downloadResult = await this.downloadFileFromDriveSafe(driveFile, baseFolder);
                    if (downloadResult.success) {
                        result.downloaded++;
                    } else {
                        result.errors++;
                        progressModal?.addLog(`❌ Download failed: ${filePath} - ${downloadResult.error}`);
                    }
                }
            } catch (error) {
                console.error(`Error syncing file ${filePath}:`, error);
                progressModal?.addLog(`❌ Unexpected error processing ${filePath}: ${error.message || 'Unknown error'}`);
                result.errors++;
            }
    
            processedInThisFolder++;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    
        return result;
    }
    
    private async resolveFileConflictSafe(
        localFile: TFile, 
        driveFile: any, 
        rootFolderId: string, 
        baseFolder: string
    ): Promise<{action: 'uploaded' | 'downloaded' | 'skipped' | 'error', error?: string}> {
        try {
            const fileState = this.getFileState(localFile.path);
            const currentLocalModTime = localFile.stat.mtime;
            const currentRemoteHash = driveFile.md5Checksum;
            
            const cachedLocalModTime = fileState.localModTime;
            const cachedRemoteHash = fileState.remoteHash;
            
            // 🔥 변경 상태 확인
            const localChanged = currentLocalModTime !== cachedLocalModTime;
            const remoteChanged = currentRemoteHash !== cachedRemoteHash;
            
            if (!localChanged && !remoteChanged) {
                console.log(`⏭️ ${localFile.name}: No actual changes - skip conflict resolution`);
                return {action: 'skipped'};
            }

            // 충돌 해결 전략
            let resolution: 'local' | 'remote';
            
            if (!remoteChanged && localChanged) {
                // 로컬만 변경됨
                resolution = 'local';
                console.log(`📤 ${localFile.name}: Only local changed - upload`);
            } else if (remoteChanged && !localChanged) {
                // 원격만 변경됨
                resolution = 'remote';
                console.log(`📥 ${localFile.name}: Only remote changed - download`);
            } else {
                // 둘 다 변경됨 - 시간 비교
                const localModTime = localFile.stat.mtime;
                const remoteModTime = new Date(driveFile.modifiedTime).getTime();
                
                console.log(`⚡ ${localFile.name}: Both changed - resolving conflict`);
                console.log(`  Local:  ${new Date(localModTime).toLocaleString()}`);
                console.log(`  Remote: ${new Date(remoteModTime).toLocaleString()}`);
                
                switch (this.settings.conflictResolution) {
                    case 'local':
                        resolution = 'local';
                        break;
                    case 'remote':
                        resolution = 'remote';
                        break;
                    case 'newer':
                    case 'ask':
                        resolution = localModTime > remoteModTime ? 'local' : 'remote';
                        break;
                }
                
                console.log(`  Resolution: Use ${resolution} file`);
            }

            if (resolution === 'local') {
                const uploadResult = await this.uploadSingleFileSafe(localFile, rootFolderId, baseFolder);
                return uploadResult.success ? {action: 'uploaded'} : {action: 'error', error: uploadResult.error};
            } else {
                const downloadResult = await this.downloadFileFromDriveSafe(driveFile, baseFolder);
                return downloadResult.success ? {action: 'downloaded'} : {action: 'error', error: downloadResult.error};
            }

        } catch (error) {
            console.error(`Error resolving conflict for ${localFile.path}:`, error);
            return {action: 'error', error: error.message || 'Unknown error'};
        }
    }

    private async uploadSingleFileSafe(
        file: TFile, 
        rootFolderId: string, 
        baseFolder: string
    ): Promise<{success: boolean, error?: string}> {
        try {
            const syncResult = await this.syncFileToGoogleDrive(file, rootFolderId, baseFolder);
            if (syncResult === true) {
                return {success: true};
            } else if (syncResult === 'skipped') {
                return {success: true}; // 스킵도 성공으로 간주
            } else {
                return {success: false, error: 'Upload failed'};
            }
        } catch (error) {
            console.error(`Upload error for ${file.path}:`, error);
            return {success: false, error: error.message || 'Unknown upload error'};
        }
    }

    private async downloadFileFromDriveSafe(
        driveFile: any, 
        baseFolder: string
    ): Promise<{success: boolean, error?: string}> {
        try {
            const result = this.createEmptyResult();
            await this.downloadFileFromDrive(driveFile, result, baseFolder);
            return {success: true};
        } catch (error) {
            console.error(`Download error for ${driveFile.name}:`, error);
            return {success: false, error: error.message || 'Unknown download error'};
        }
    }

    private async uploadBinaryFileToDriveStandard(fileName: string, content: ArrayBuffer, folderId: string, metadata: any): Promise<any> {
        try {
            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";
    
            const uint8Content = new Uint8Array(content);
            
            // FIX: Use chunked approach instead of spread operator to avoid stack overflow
            let base64Content: string;
            const CHUNK_SIZE = 8192; // 8KB chunks (safe size)
            
            if (uint8Content.length > CHUNK_SIZE) {
                console.log(`Large binary file (${this.formatFileSize(content.byteLength)}) - using safe chunked conversion`);
                base64Content = await this.convertToBase64Safe(uint8Content);
            } else {
                // Use existing method for small files
                base64Content = btoa(String.fromCharCode(...uint8Content));
            }
            
            const metadataJson = JSON.stringify(metadata);
            
            const body = delimiter +
                'Content-Type: application/json\r\n\r\n' +
                metadataJson + delimiter +
                'Content-Type: application/octet-stream\r\n' +
                'Content-Transfer-Encoding: base64\r\n\r\n' +
                base64Content + close_delim;
    
            console.log(`Uploading ${fileName} (${this.formatFileSize(content.byteLength)} → ${this.formatFileSize(body.length)})`);
    
            return await this.makeAuthenticatedRequest(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,md5Checksum,version,size',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/related; boundary="${boundary}"`
                    },
                    body: body
                }
            );
        } catch (error) {
            console.error(`Binary file upload error for ${fileName}:`, error);
            throw error;
        }
    }

    // Safe Base64 conversion without spread operator
    private async convertToBase64Safe(uint8Array: Uint8Array): Promise<string> {
        const CHUNK_SIZE = 8192; // 8KB chunks
        let result = '';
        
        try {
            for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
                const chunk = uint8Array.slice(i, i + CHUNK_SIZE);
                
                // Convert chunk to string without spread operator
                let chunkStr = '';
                for (let j = 0; j < chunk.length; j++) {
                    chunkStr += String.fromCharCode(chunk[j]);
                }
                
                // Base64 conversion
                const chunkBase64 = btoa(chunkStr);
                result += chunkBase64;
            }
            
            console.log(`Safe Base64 conversion completed: ${uint8Array.length} bytes → ${result.length} chars`);
            return result;
            
        } catch (error) {
            console.error('Safe Base64 conversion failed:', error);
            
            // Fallback: Use FileReader API (browser environment)
            return await this.convertToBase64Fallback(uint8Array);
        }
    }

    // Fallback: FileReader-based Base64 conversion
    private async convertToBase64Fallback(uint8Array: Uint8Array): Promise<string> {
        try {
            console.log('Using FileReader fallback for Base64 conversion');
            
            // Convert to Blob and use FileReader
            const blob = new Blob([uint8Array]);
            const reader = new FileReader();
            
            return new Promise<string>((resolve, reject) => {
                reader.onload = () => {
                    const result = reader.result as string;
                    // Remove data:application/octet-stream;base64, prefix
                    const base64 = result.split(',')[1];
                    console.log(`FileReader Base64 conversion completed`);
                    resolve(base64);
                };
                
                reader.onerror = () => {
                    reject(new Error('FileReader Base64 conversion failed'));
                };
                
                reader.readAsDataURL(blob);
            });
            
        } catch (error) {
            console.error('FileReader fallback failed:', error);
            throw new Error('All Base64 conversion methods failed');
        }
    } 

    // Better alternative: Simple Upload for large files
    private async uploadLargeFileSimple(fileName: string, content: ArrayBuffer, folderId: string, metadata: any): Promise<any> {
        try {
            console.log(`Using simple upload for large file: ${fileName}`);
            
            // Step 1: Create file metadata only
            const metadataResponse = await this.makeAuthenticatedRequest(
                'https://www.googleapis.com/drive/v3/files',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(metadata)
                }
            );

            if (metadataResponse.status !== 200 && metadataResponse.status !== 201) {
                throw new Error(`File creation failed: ${metadataResponse.status}`);
            }

            const fileId = metadataResponse.json.id;
            console.log(`File metadata created: ${fileId}`);

            // Step 2: Upload file content (without Base64 conversion)
            const contentResponse = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,modifiedTime,md5Checksum,version,size`,
                {
                    method: 'PATCH',
                    headers: { 
                        'Content-Type': 'application/octet-stream'
                    },
                    body: content // Direct ArrayBuffer transmission (no Base64 conversion needed)
                }
            );

            if (contentResponse.status === 200 || contentResponse.status === 201) {
                console.log(`File content uploaded successfully: ${fileName}`);
                return contentResponse;
            } else {
                throw new Error(`Content upload failed: ${contentResponse.status}`);
            }

        } catch (error) {
            console.error(`Simple upload failed for ${fileName}:`, error);
            throw error;
        }
    }   

    
    private async uploadTextFileToDriveStandard(fileName: string, content: string, folderId: string, metadata: any) {
        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";
    
        const body = delimiter +
            'Content-Type: application/json\r\n\r\n' +
            JSON.stringify(metadata) + delimiter +
            'Content-Type: text/plain\r\n\r\n' +
            content + close_delim;
    
        return await this.makeAuthenticatedRequest(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/related; boundary="${boundary}"`
                },
                body: body
            }
        );
    }
    


    // Updated main file upload method
    private async uploadFileToDrive(fileName: string, content: string | ArrayBuffer, folderId: string, localModTime?: number): Promise<{success: boolean, fileData?: any}> {
        try {
            const metadata = {
                name: fileName,
                parents: [folderId],
                modifiedTime: localModTime ? new Date(localModTime).toISOString() : undefined
            };

            let uploadResponse;

            if (this.isBinaryFile(fileName)) {
                const binaryContent = content instanceof ArrayBuffer ? content : new TextEncoder().encode(content as string).buffer;
                const fileSize = binaryContent.byteLength;
                
                console.log(`Uploading binary file: ${fileName} (${this.formatFileSize(fileSize)})`);
                
                // Upload strategy based on file size
                if (fileSize > 100 * 1024) { // Files larger than 100KB
                    console.log(`Large binary file detected - using simple upload`);
                    uploadResponse = await this.uploadLargeFileSimple(fileName, binaryContent, folderId, metadata);
                } else {
                    console.log(`Small binary file - using multipart upload`);
                    uploadResponse = await this.uploadBinaryFileToDriveStandard(fileName, binaryContent, folderId, metadata);
                }
            } else {
                // Text files
                uploadResponse = await this.uploadTextFileToDriveStandard(fileName, content as string, folderId, metadata);
            }

            const success = uploadResponse.status === 200 || uploadResponse.status === 201;
            
            if (success) {
                const fileData = uploadResponse.json;
                console.log(`${fileName}: Upload successful`);
                return { success: true, fileData: fileData };
            } else {
                console.error(`${fileName}: Upload failed - Status: ${uploadResponse.status}`);
                return { success: false };
            }
        } catch (error) {
            console.error(`${fileName}: Upload error - ${error.message}`);
            return { success: false };
        }
    }
    // File size formatting utility
    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }  

    // 업로드 전용 메서드
    async uploadToGoogleDrive(showProgress: boolean = false): Promise<SyncResult> {
        console.log('Starting optimized upload to Google Drive...');
        const result = this.createEmptyResult();

        // 폴더 캐시 초기화
        this.clearFolderCache();

        let progressModal: SyncProgressModal | undefined = undefined;
        
        if (showProgress) {
            progressModal = new SyncProgressModal(this.app);
            progressModal.open();
            progressModal.addLog('🔍 Collecting files to upload...');
            progressModal.updateStatus('Preparing optimized upload...');
        }

        try {
            let allFiles: TFile[] = [];
            let folderTargets: Array<{files: TFile[], folderId: string, name: string, basePath: string}> = [];

            if (this.settings.syncWholeVault) {
                progressModal?.addLog('📁 Sync mode: Whole Vault');
                
                const rootFolder = await this.getOrCreateDriveFolder();
                if (!rootFolder) {
                    throw new Error('Failed to create or find Google Drive folder');
                }

                allFiles = this.app.vault.getFiles().filter(file => this.shouldSyncFileType(file));
                folderTargets.push({
                    files: allFiles,
                    folderId: rootFolder.id,
                    name: rootFolder.name,
                    basePath: ''
                });
            } else {
                progressModal?.addLog('📂 Sync mode: Selected Folders');
                
                for (const driveFolder of this.settings.selectedDriveFolders) {
                    const localFiles = await this.getLocalFilesForDriveFolder(driveFolder);
                    folderTargets.push({
                        files: localFiles,
                        folderId: driveFolder.id,
                        name: driveFolder.name,
                        basePath: driveFolder.path
                    });
                    allFiles.push(...localFiles);
                }
            }

            progressModal?.addLog(`📋 Found ${allFiles.length} files to process`);

            // 폴더별로 파일들을 그룹화하여 폴더 생성 최적화
            for (const target of folderTargets) {
                if (progressModal?.shouldCancel()) {
                    progressModal.markCancelled();
                    return result;
                }

                progressModal?.addLog(`📤 Processing folder: ${target.name} (${target.files.length} files)`);
                progressModal?.addLog('🚀 Pre-creating folder structure...');

                // 1단계: 필요한 모든 폴더 구조를 미리 생성 (배치 처리)
                await this.preCreateFolderStructures(target.files, target.folderId, target.basePath, progressModal);

                // 2단계: 파일 업로드 (폴더 구조는 이미 캐시됨)
                progressModal?.addLog('📤 Starting file uploads...');
                await this.batchUploadFiles(target.files, target.folderId, target.basePath, result, progressModal, allFiles.length);
            }

            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();

            progressModal?.addLog('🎉 Optimized upload completed successfully!');

            if (!showProgress) {
                this.reportSyncResult(result);
            } else if (progressModal) {
                progressModal.markCompleted(result);
            }

        } catch (error) {
            console.error('Upload error:', error);
            const errorMessage = `Upload error: ${error.message || 'Unknown error'}`;
            
            if (progressModal) {
                progressModal.addLog(`❌ ${errorMessage}`);
                progressModal.updateStatus('Upload failed');
                setTimeout(() => progressModal?.markCancelled(), 2000);
            } else {
                new Notice(`❌ ${errorMessage}`);
            }
            
            result.errors++;
        }

        return result;
    }

    // 폴더 구조 미리 생성 메서드
    private async preCreateFolderStructures(
        files: TFile[], 
        rootFolderId: string, 
        baseFolder: string, 
        progressModal?: SyncProgressModal
    ): Promise<void> {
        // 필요한 모든 폴더 경로 수집
        const requiredFolders = new Set<string>();
        
        for (const file of files) {
            let relativePath = file.path;
            
            if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                relativePath = file.path.substring(baseFolder.length + 1);
            } else if (!baseFolder) {
                relativePath = file.path;
            }
            
            if (relativePath.includes('/')) {
                const pathParts = relativePath.split('/');
                pathParts.pop(); // 파일명 제거
                const folderPath = pathParts.join('/');
                
                // 중첩된 모든 폴더 경로 추가
                const parts = folderPath.split('/');
                for (let i = 1; i <= parts.length; i++) {
                    const partialPath = parts.slice(0, i).join('/');
                    requiredFolders.add(partialPath);
                }
            }
        }

        progressModal?.addLog(`📁 Need to ensure ${requiredFolders.size} folder paths exist`);

        // 폴더 경로를 깊이순으로 정렬 (부모 폴더부터 생성)
        const sortedFolders = Array.from(requiredFolders).sort((a, b) => {
            const depthA = a.split('/').length;
            const depthB = b.split('/').length;
            return depthA - depthB;
        });

        // 폴더들을 배치로 생성
        for (const folderPath of sortedFolders) {
            if (progressModal?.shouldCancel()) return;
            
            if (!this.folderCache[folderPath]) {
                await this.getCachedFolderId(folderPath, rootFolderId);
                
                // 폴더 생성 간 작은 지연
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        progressModal?.addLog(`✅ Folder structure ready (${Object.keys(this.folderCache).length} folders cached)`);
    }


    // 배치 파일 업로드 메서드
    private async batchUploadFiles(
        files: TFile[], 
        rootFolderId: string, 
        baseFolder: string, 
        result: SyncResult, 
        progressModal?: SyncProgressModal,
        totalFiles: number = 0
    ): Promise<void> {
        let processedFiles = 0;
        
        for (const file of files) {
            if (progressModal?.shouldCancel()) return;
    
            try {
                progressModal?.updateProgress(processedFiles, totalFiles || files.length, `Processing: ${file.name}`);
    
                const syncResult = await this.syncFileToGoogleDrive(file, rootFolderId, baseFolder);
                
                if (syncResult === 'skipped') {
                    result.skipped++;
                    // 간명한 로그: 개별 스킵 메시지는 콘솔에만, 진행 모달에는 요약만
                } else if (syncResult === true) {
                    result.uploaded++;
                    progressModal?.addLog(`✅ ${file.name}`);
                } else {
                    result.errors++;
                    progressModal?.addLog(`❌ ${file.name}`);
                }
            } catch (error) {
                result.errors++;
                progressModal?.addLog(`❌ ${file.name}: ${error.message || 'Error'}`);
            }
    
            processedFiles++;
            
            // 배치 상태 요약 로그 (매 10개 파일마다)
            if (processedFiles % 10 === 0) {
                progressModal?.addLog(`📊 Progress: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.errors} errors`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    // 기존 createNestedFolders 메서드는 그대로 유지하되, 캐시 활용
    private async createNestedFolders(folderPath: string, rootFolderId: string): Promise<string> {
        const pathParts = folderPath.split('/');
        let currentFolderId = rootFolderId;
        let currentPath = '';

        for (const folderName of pathParts) {
            if (!folderName) continue;
            
            currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;
            
            // 캐시에서 먼저 확인
            if (this.folderCache[currentPath]) {
                currentFolderId = this.folderCache[currentPath];
                continue;
            }
            
            const existingFolder = await this.findFolderInDrive(folderName, currentFolderId);
            
            if (existingFolder) {
                currentFolderId = existingFolder.id;
                this.folderCache[currentPath] = currentFolderId; // 캐시에 저장
                console.log(`✓ Found and cached existing folder: ${folderName} at ${currentPath}`);
            } else {
                const newFolder = await this.createFolderInDrive(folderName, currentFolderId);
                if (!newFolder) {
                    throw new Error(`Failed to create folder: ${folderName}`);
                }
                currentFolderId = newFolder.id;
                this.folderCache[currentPath] = currentFolderId; // 캐시에 저장
                console.log(`📁 Created and cached folder: ${folderName} at ${currentPath}`);
            }
        }

        return currentFolderId;
    }

    // 다운로드 전용 메서드
    async downloadFromGoogleDrive(showProgress: boolean = false): Promise<SyncResult> {
        console.log('Starting download from Google Drive...');
        const result = this.createEmptyResult();
    
        let progressModal: SyncProgressModal | undefined = undefined;
        
        if (showProgress) {
            progressModal = new SyncProgressModal(this.app);
            progressModal.open();
            progressModal.addLog('🔍 Collecting files to download...');
            progressModal.updateStatus('Preparing download...');
        }
    
        try {
            let allDriveFiles: any[] = [];
    
            if (this.settings.syncWholeVault) {
                progressModal?.addLog('📁 Download mode: Whole Vault');
                
                const rootFolder = await this.getOrCreateDriveFolder();
                if (!rootFolder) {
                    throw new Error('Failed to find Google Drive folder');
                }
    
                allDriveFiles = await this.getAllFilesFromDrive(rootFolder.id);
            } else {
                progressModal?.addLog('📂 Download mode: Selected Folders');
                
                for (const driveFolder of this.settings.selectedDriveFolders) {
                    const driveFiles = await this.getAllFilesFromDrive(driveFolder.id, driveFolder.path);
                    allDriveFiles.push(...driveFiles);
                }
            }
    
            progressModal?.addLog(`📋 Found ${allDriveFiles.length} files to download`);
            progressModal?.updateProgress(0, allDriveFiles.length);
    
            for (let i = 0; i < allDriveFiles.length; i++) {
                if (progressModal?.shouldCancel()) {
                    progressModal.markCancelled();
                    return result;
                }
    
                const driveFile = allDriveFiles[i];
                
                try {
                    progressModal?.updateProgress(i, allDriveFiles.length, `Downloading: ${driveFile.name}`);
                    progressModal?.addLog(`📥 ${driveFile.path}`);
    
                    await this.downloadFileFromDrive(driveFile, result);
                    progressModal?.addLog(`✅ Downloaded: ${driveFile.name}`);
                    
                } catch (error) {
                    result.errors++;
                    progressModal?.addLog(`❌ Error downloading ${driveFile.name}: ${error.message || 'Unknown error'}`);
                }
    
                // 작은 지연으로 UI 업데이트 허용
                await new Promise(resolve => setTimeout(resolve, 10));
            }
    
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();
    
            progressModal?.addLog('🎉 Download completed successfully!');
    
            // 진행 상태가 표시되지 않는 경우 기존 방식으로 결과 표시
            if (!showProgress) {
                this.reportSyncResult(result);
            } else if (progressModal) {
                progressModal.markCompleted(result);
            }
    
        } catch (error) {
            console.error('Download error:', error);
            const errorMessage = `Download error: ${error.message || 'Unknown error'}`;
            
            if (progressModal) {
                progressModal.addLog(`❌ ${errorMessage}`);
                progressModal.updateStatus('Download failed');
                setTimeout(() => progressModal?.markCancelled(), 2000);
            } else {
                new Notice(`❌ ${errorMessage}`);
            }
            
            result.errors++;
        }
    
        return result;
    }

    // Google Drive 폴더에 해당하는 로컬 파일들 가져오기
    async getLocalFilesForDriveFolder(driveFolder: {id: string, name: string, path: string}): Promise<TFile[]> {
        const localFiles: TFile[] = [];
        
        // Google Drive 폴더 경로를 로컬 경로로 변환
        const localFolderPath = driveFolder.path;
        
        console.log(`Looking for local files in: ${localFolderPath} (for Drive folder: ${driveFolder.name})`);
        
        // 로컬에서 해당 경로의 폴더 찾기
        const localFolder = this.app.vault.getAbstractFileByPath(localFolderPath);
        
        if (localFolder instanceof TFolder) {
            const files = await this.collectFilesToSync(localFolder, this.settings.includeSubfolders);
            localFiles.push(...files);
            console.log(`Found ${files.length} files in local folder: ${localFolderPath}`);
        } else {
            console.log(`Local folder not found: ${localFolderPath}`);
        }
        
        return localFiles;
    }

    // 양방향 동기화 수행
    async bidirectionalSync(showProgress: boolean = false): Promise<SyncResult> {
        console.log('Starting bidirectional sync...');
        const result = this.createEmptyResult();
    
        let progressModal: SyncProgressModal | undefined = undefined;
        
        if (showProgress) {
            progressModal = new SyncProgressModal(this.app);
            progressModal.open();
            progressModal.addLog('🔍 Analyzing local and remote files...');
            progressModal.updateStatus('Preparing bidirectional sync...');
        }
    
        try {
            // 🔥 모든 동기화 대상을 미리 수집하여 전체 진행률 계산
            const syncTargets: Array<{
                localFiles: TFile[], 
                driveFiles: any[], 
                rootFolderId: string, 
                baseFolder: string,
                folderName: string
            }> = [];
    
            if (this.settings.syncWholeVault) {
                progressModal?.addLog('📁 Bidirectional mode: Whole Vault');
                
                const rootFolder = await this.getOrCreateDriveFolder();
                if (!rootFolder) {
                    throw new Error('Failed to create or find Google Drive folder');
                }
    
                progressModal?.addLog('📱 Collecting local files...');
                const localFiles = this.app.vault.getFiles().filter(file => this.shouldSyncFileType(file));
                
                progressModal?.addLog('☁️ Collecting remote files...');
                const driveFiles = await this.getAllFilesFromDrive(rootFolder.id);
    
                syncTargets.push({
                    localFiles,
                    driveFiles,
                    rootFolderId: rootFolder.id,
                    baseFolder: '',
                    folderName: 'Whole Vault'
                });
            } else {
                progressModal?.addLog('📂 Bidirectional mode: Selected Folders');
                
                for (const driveFolder of this.settings.selectedDriveFolders) {
                    try {
                        progressModal?.addLog(`📁 Collecting files for: ${driveFolder.name}`);
                        
                        const localFiles = await this.getLocalFilesForDriveFolder(driveFolder);
                        const driveFiles = await this.getAllFilesFromDrive(driveFolder.id, driveFolder.path);
                        
                        syncTargets.push({
                            localFiles,
                            driveFiles,
                            rootFolderId: driveFolder.id,
                            baseFolder: driveFolder.path,
                            folderName: driveFolder.name
                        });
                    } catch (error) {
                        console.error(`❌ Error collecting files for folder ${driveFolder.name}:`, error);
                        progressModal?.addLog(`❌ Error collecting files for ${driveFolder.name}: ${error.message}`);
                        result.errors++;
                    }
                }
            }
    
            // 🔥 전체 파일 수 계산 (정확한 진행률을 위해)
            let totalFileCount = 0;
            let processedFileCount = 0;
            
            for (const target of syncTargets) {
                const localPaths = new Set(target.localFiles.map(f => this.getRelativePath(f.path, target.baseFolder)));
                const remotePaths = new Set(target.driveFiles.map(f => this.getRelativePath(f.path, target.baseFolder)));
                const allPaths = new Set([...localPaths, ...remotePaths]);
                totalFileCount += allPaths.size;
            }
    
            progressModal?.addLog(`📊 Total unique files to process: ${totalFileCount}`);
            progressModal?.updateProgress(0, totalFileCount, 'Starting sync...');
    
            // 🔥 각 동기화 대상을 순차적으로 처리하되 전체 진행률 유지
            for (const target of syncTargets) {
                if (progressModal?.shouldCancel()) {
                    progressModal.markCancelled();
                    return result;
                }
    
                progressModal?.addLog(`🔄 Processing: ${target.folderName} (${target.localFiles.length} local, ${target.driveFiles.length} remote)`);
    
                const folderResult = await this.performBidirectionalSyncWithGlobalProgress(
                    target.localFiles, 
                    target.driveFiles, 
                    target.rootFolderId, 
                    target.baseFolder,
                    progressModal,
                    processedFileCount,
                    totalFileCount
                );
    
                // 결과 누적
                result.uploaded += folderResult.uploaded;
                result.downloaded += folderResult.downloaded;
                result.skipped += folderResult.skipped;
                result.conflicts += folderResult.conflicts;
                result.errors += folderResult.errors;
                result.createdFolders.push(...folderResult.createdFolders);
    
                // 처리된 파일 수 업데이트
                const localPaths = new Set(target.localFiles.map(f => this.getRelativePath(f.path, target.baseFolder)));
                const remotePaths = new Set(target.driveFiles.map(f => this.getRelativePath(f.path, target.baseFolder)));
                const allPaths = new Set([...localPaths, ...remotePaths]);
                processedFileCount += allPaths.size;
            }
    
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();
    
            progressModal?.addLog('🎉 Bidirectional sync completed successfully!');
    
            if (!showProgress) {
                this.reportSyncResult(result);
            } else if (progressModal) {
                progressModal.markCompleted(result);
            }
    
        } catch (error) {
            console.error('Bidirectional sync error:', error);
            const errorMessage = `Bidirectional sync error: ${error.message || 'Unknown error'}`;
            
            if (progressModal) {
                progressModal.addLog(`❌ ${errorMessage}`);
                progressModal.updateStatus('Bidirectional sync failed');
                setTimeout(() => progressModal?.markCancelled(), 2000);
            } else {
                new Notice(`❌ ${errorMessage}`);
            }
            
            result.errors++;
        }
    
        return result;
    }

    // Google Drive에서 파일 다운로드
    private async downloadFileFromDrive(driveFile: any, result: SyncResult, baseFolder: string = ''): Promise<void> {
        try {
            let filePath = driveFile.path;
            
            if (baseFolder && !filePath.startsWith(baseFolder + '/') && filePath !== baseFolder) {
                filePath = baseFolder + '/' + filePath;
            }
            
            const localFile = this.app.vault.getAbstractFileByPath(filePath);

            // 다운로드 필요 여부 확인
            if (localFile instanceof TFile) {
                const needsUpdate = await this.shouldDownloadFile(localFile, driveFile);
                if (!needsUpdate) {
                    result.skipped++;
                    return;
                }
            }

            // 파일 다운로드
            const content = await this.getFileContentFromDrive(driveFile.id, driveFile.name);
            const remoteModTime = new Date(driveFile.modifiedTime).getTime();

            // 폴더 생성
            const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
            if (folderPath && this.settings.createMissingFolders) {
                await this.createLocalFolderStructure(folderPath, result);
            }

            // 파일 저장
            if (this.isTextFile(driveFile.name)) {
                if (localFile instanceof TFile) {
                    await this.app.vault.modify(localFile, content as string);
                } else {
                    await this.app.vault.create(filePath, content as string);
                }
            } else {
                const binaryContent = new Uint8Array(content as ArrayBuffer);
                if (localFile instanceof TFile) {
                    await this.app.vault.modifyBinary(localFile, binaryContent);
                } else {
                    await this.app.vault.createBinary(filePath, binaryContent);
                }
            }

            // 파일 시간 동기화
            await this.syncFileTime(filePath, remoteModTime);

            // 🔥 상태 캐시 업데이트 (mtime 기반)
            const updatedLocalFile = this.app.vault.getAbstractFileByPath(filePath) as TFile;
            if (updatedLocalFile) {
                this.setFileState(filePath, {
                    localModTime: updatedLocalFile.stat.mtime,  // 🔥 실제 저장된 파일의 mtime
                    remoteHash: driveFile.md5Checksum,
                    remoteModTime: remoteModTime,
                    lastSyncTime: Date.now(),
                    version: driveFile.version
                });
                
                await this.saveSettings();
                console.log(`💾 Download state cached for ${filePath}: localMtime=${updatedLocalFile.stat.mtime}, remoteHash=${driveFile.md5Checksum}`);
            }
            
            result.downloaded++;

        } catch (error) {
            console.error(`❌ ${driveFile.name}: Download failed - ${error.message}`);
            result.errors++;
            throw error;
        }
    }

    // 파일 시간 동기화 메서드
    private async syncFileTime(filePath: string, targetTime: number): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            
            // Node.js 환경(데스크톱)에서 직접 파일시스템 접근
            if (adapter.constructor.name === 'FileSystemAdapter') {
                try {
                    // @ts-ignore - Node.js FileSystemAdapter 전용
                    const fs = require('fs').promises;
                    // @ts-ignore - Node.js path 모듈
                    const path = require('path');
                    // @ts-ignore - basePath 접근
                    const fullPath = path.join(adapter.basePath, filePath);
                    
                    const targetDate = new Date(targetTime);
                    await fs.utimes(fullPath, targetDate, targetDate);
                    
                    console.log(`⏰ ${path.basename(filePath)}: Time synced to ${targetDate.toLocaleString()}`);
                    return;
                } catch (fsError) {
                    console.warn(`⚠️ ${filePath}: Direct FS time sync failed`);
                }
            }
            
            // Obsidian API를 통한 우회 방법
            try {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    // @ts-ignore - 내부 속성 접근
                    if (file.stat && file.stat.mtime !== undefined) {
                        // @ts-ignore - mtime 수정 시도
                        file.stat.mtime = targetTime;
                        console.log(`⏰ ${file.name}: API time sync to ${new Date(targetTime).toLocaleString()}`);
                        return;
                    }
                }
            } catch (obsidianError) {
                console.warn(`⚠️ ${filePath}: API time sync failed`);
            }
            
        } catch (error) {
            console.warn(`⚠️ ${filePath}: Time sync failed - ${error.message}`);
        }
    }

    // 로컬 폴더 구조 생성
    private async createLocalFolderStructure(folderPath: string, result: SyncResult): Promise<void> {
        if (!folderPath) return;

        const pathParts = folderPath.split('/');
        let currentPath = '';

        for (const part of pathParts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            
            const existingFolder = this.app.vault.getAbstractFileByPath(currentPath);
            if (!existingFolder) {
                try {
                    await this.app.vault.createFolder(currentPath);
                    console.log(`📁 Created local folder: ${currentPath}`);
                    result.createdFolders.push(currentPath);
                } catch (error) {
                    // 폴더가 이미 존재하는 경우 무시
                    if (!error.message.includes('already exists')) {
                        throw error;
                    }
                }
            }
        }
    }

    // 파일 충돌 해결
    private async resolveFileConflict(localFile: TFile, driveFile: any, rootFolderId: string, result: SyncResult, baseFolder: string = ''): Promise<void> {
        const localModTime = localFile.stat.mtime;
        const remoteModTime = new Date(driveFile.modifiedTime).getTime();

        // 1초 이내 차이는 동일한 것으로 간주 (파일시스템 정밀도 고려)
        const timeDiff = Math.abs(localModTime - remoteModTime);
        const TIME_TOLERANCE = 1000; // 1초

        if (timeDiff <= TIME_TOLERANCE) {
            // 시간이 거의 같으면 충돌이 아니라 동기화된 상태
            console.log(`⏭️ ${localFile.name}: Files are already synced (time diff: ${timeDiff}ms)`);
            result.skipped++;
            return; // 충돌로 카운트하지 않음
        }

        // ⚠️ 여기서부터가 실제 충돌 상황
        let resolution: 'local' | 'remote';
        let isActualConflict = false; // 실제 충돌 여부 추적

        switch (this.settings.conflictResolution) {
            case 'local':
                resolution = 'local';
                break;
            case 'remote':
                resolution = 'remote';
                break;
            case 'newer':
                resolution = localModTime > remoteModTime ? 'local' : 'remote';
                break;
            case 'ask':
                resolution = localModTime > remoteModTime ? 'local' : 'remote';
                console.log(`Conflict resolved automatically (newer): ${localFile.path} -> ${resolution}`);
                break;
        }

        // 🔥 실제 충돌 해결이 필요한 경우에만 로그 출력
        console.log(`⚡ Conflict detected: ${localFile.name}`);
        console.log(`  Local:  ${new Date(localModTime).toLocaleString()}`);
        console.log(`  Remote: ${new Date(remoteModTime).toLocaleString()}`);
        console.log(`  Resolution: Use ${resolution} file`);

        try {
            if (resolution === 'local') {
                // 로컬 파일로 원격 파일 업데이트
                const syncResult = await this.syncFileToGoogleDrive(localFile, rootFolderId, baseFolder);
                if (syncResult === 'skipped') {
                    result.skipped++;
                    console.log(`⏭️ ${localFile.name}: Actually skipped after conflict check`);
                } else if (syncResult === true) {
                    result.uploaded++;
                    result.conflicts++; // ✅ 실제로 업로드된 경우에만 충돌로 카운트
                    isActualConflict = true;
                } else {
                    result.errors++;
                }
            } else {
                // 원격 파일로 로컬 파일 업데이트
                const shouldDownload = await this.shouldDownloadFile(localFile, driveFile);
                if (shouldDownload) {
                    await this.downloadFileFromDrive(driveFile, result, baseFolder);
                    result.downloaded++;
                    result.conflicts++; // ✅ 실제로 다운로드된 경우에만 충돌로 카운트
                    isActualConflict = true;
                } else {
                    result.skipped++;
                    console.log(`⏭️ ${localFile.name}: Actually skipped after download check`);
                }
            }

            // 실제 충돌이 해결된 경우에만 해결 로그 출력
            if (isActualConflict) {
                console.log(`✅ Conflict resolved: ${localFile.name} (used ${resolution} version)`);
            }

        } catch (error) {
            console.error(`Error resolving conflict for ${localFile.path}:`, error);
            result.errors++;
        }
    }

    // 단일 파일 업로드
    private async uploadSingleFile(file: TFile, rootFolderId: string, result: SyncResult, baseFolder: string = ''): Promise<void> {
        try {
            const syncResult = await this.syncFileToGoogleDrive(file, rootFolderId, baseFolder);
            if (syncResult === 'skipped') {
                result.skipped++;
            } else if (syncResult === true) {
                result.uploaded++;
            } else {
                result.errors++;
            }
        } catch (error) {
            console.error(`Error uploading file ${file.path}:`, error);
            result.errors++;
        }
    }

    // 여러 파일 업로드
    private async uploadFilesToDrive(filesToSync: TFile[], rootFolderId: string, result: SyncResult): Promise<void> {
        for (const file of filesToSync) {
            await this.uploadSingleFile(file, rootFolderId, result);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // Google Drive에서 모든 파일 가져오기 (재귀적으로 폴더 구조 포함)
    async getAllFilesFromDrive(folderId: string, basePath: string = ''): Promise<any[]> {
        const allFiles: any[] = [];
        
        try {
            let pageToken = '';
            
            do {
                const query = `'${folderId}' in parents and trashed=false`;
                const params = new URLSearchParams({
                    q: query,
                    fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,parents,md5Checksum,version)', // 🔥 md5Checksum 추가
                    pageSize: '1000',
                    supportsAllDrives: 'true',
                    includeItemsFromAllDrives: 'true'
                });
                
                if (pageToken) {
                    params.append('pageToken', pageToken);
                }
                
                const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
                const response = await this.makeAuthenticatedRequest(url, { method: 'GET' });

                if (response.status !== 200) {
                    console.error('Failed to list files:', response.status, response.json);
                    break;
                }

                const data = response.json;
                
                const regularFiles: any[] = [];
                const folders: any[] = [];
             
                // 🔥 파일 타입별로 분류
                for (const file of data.files || []) {
                    if (file.mimeType === 'application/vnd.google-apps.folder') {
                        folders.push(file);
                    } else {
                        regularFiles.push(file);
                    }
                }
                
                // 🔥 일반 파일 처리 (md5Checksum 포함)
                for (const file of regularFiles) {
                    const filePath = basePath ? `${basePath}/${file.name}` : file.name;
                    allFiles.push({
                        ...file,
                        path: filePath
                    });
                    console.log(`📄 Found file: ${file.name}, hash: ${file.md5Checksum || 'none'}, modified: ${file.modifiedTime}`);
                }
                
            
                
                // 🔥 폴더 재귀 처리
                if (this.settings.includeSubfolders) {
                    for (const folder of folders) {
                        const folderPath = basePath ? `${basePath}/${folder.name}` : folder.name;
                        try {
                            const subFiles = await this.getAllFilesFromDrive(folder.id, folderPath);
                            allFiles.push(...subFiles);
                        } catch (error) {
                            console.error(`❌ Error processing folder ${folder.name}:`, error);
                        }
                    }
                }

                pageToken = data.nextPageToken || '';
            } while (pageToken);

        } catch (error) {
            console.error('Error getting files from Drive:', error);
            throw error;
        }

        return allFiles;
    }


    // 파일 다운로드 필요 여부 판단
    private async shouldDownloadFile(localFile: TFile, driveFile: any): Promise<boolean> {
        try {
            const filePath = localFile.path;
            const fileState = this.getFileState(filePath);
            
            // 원격 파일 정보
            const remoteHash = driveFile.md5Checksum;
            const remoteModTime = new Date(driveFile.modifiedTime).getTime();
            
            if (!remoteHash) {
                console.log(`📥 ${localFile.name}: No remote hash - download needed`);
                return true;
            }

            // 캐시된 상태
            const cachedRemoteHash = fileState.remoteHash;
            const cachedRemoteModTime = fileState.remoteModTime;
            const cachedLocalModTime = fileState.localModTime;
            
            // 🔥 로컬 파일이 변경되었는지 확인 (mtime)
            const localFileChanged = localFile.stat.mtime !== cachedLocalModTime;
            
            // 🔥 원격 파일이 변경되었는지 확인 (해시)
            const remoteFileChanged = remoteHash !== cachedRemoteHash ||
                                    remoteModTime !== cachedRemoteModTime;
            
            // 원격 파일이 변경되지 않았고, 로컬 파일도 변경되지 않았으면 스킵
            if (!remoteFileChanged && !localFileChanged) {
                console.log(`⏭️ ${localFile.name}: No changes detected - skip download`);
                return false;
            }
            
            // 원격 파일만 변경된 경우 다운로드 필요
            if (remoteFileChanged && !localFileChanged) {
                console.log(`📥 ${localFile.name}: Remote file changed - download needed`);
                console.log(`  Remote hash: ${remoteHash} (was: ${cachedRemoteHash})`);
                return true;
            }
            
            // 둘 다 변경된 경우 충돌 해결 필요
            if (remoteFileChanged && localFileChanged) {
                console.log(`⚡ ${localFile.name}: Both files changed - conflict resolution needed`);
                return true;
            }
            
            // 로컬만 변경된 경우 다운로드 불필요
            console.log(`⏭️ ${localFile.name}: Only local file changed - skip download`);
            return false;

        } catch (error) {
            console.error(`❌ ${localFile.name}: Download check error - ${error.message}`);
            return true; // 에러 시 안전하게 다운로드
        }
    }

    // 동기화 결과 객체 생성
    private createEmptyResult(): SyncResult {
        return {
            uploaded: 0,
            downloaded: 0,
            skipped: 0,
            conflicts: 0,
            errors: 0,
            createdFolders: []
        };
    }

    // 동기화 결과 보고
    private reportSyncResult(result: SyncResult): void {
        const messages: string[] = [];
        
        if (result.uploaded > 0) messages.push(`${result.uploaded} uploaded`);
        if (result.downloaded > 0) messages.push(`${result.downloaded} downloaded`);
        if (result.skipped > 0) messages.push(`${result.skipped} skipped`);
        if (result.conflicts > 0) messages.push(`${result.conflicts} conflicts resolved`);
        if (result.createdFolders.length > 0) messages.push(`${result.createdFolders.length} folders created`);
        
        const summary = messages.length > 0 ? messages.join(', ') : 'No changes';
        
        if (result.errors === 0) {
            new Notice(`✅ Sync completed: ${summary}`);
        } else {
            new Notice(`⚠️ Sync completed with ${result.errors} errors: ${summary}`);
        }

        if (result.createdFolders.length > 0) {
            console.log('Created folders:', result.createdFolders);
        }
    }

    // 파일 수집 메서드
    async collectFilesToSync(folder: TFolder, includeSubfolders: boolean): Promise<TFile[]> {
        const files: TFile[] = [];

        for (const child of folder.children) {
            if (child instanceof TFile) {
                if (this.shouldSyncFileType(child)) {
                    files.push(child);
                }
            } else if (child instanceof TFolder && includeSubfolders) {
                const subfolderFiles = await this.collectFilesToSync(child, true);
                files.push(...subfolderFiles);
            }
        }

        return files;
    }

    private async shouldSyncFile(localFile: TFile, driveFile?: any): Promise<boolean> {
        try {
            const filePath = localFile.path;
            const fileState = this.getFileState(filePath);
            
            // 새 파일인 경우 업로드 필요
            if (!driveFile) {
                console.log(`📤 ${localFile.name}: New file - upload needed`);
                return true;
            }

            const currentLocalModTime = localFile.stat.mtime;
            const currentRemoteHash = driveFile.md5Checksum;
            const currentRemoteModTime = new Date(driveFile.modifiedTime).getTime();
            
            // 캐시된 상태
            const cachedLocalModTime = fileState.localModTime;
            const cachedRemoteHash = fileState.remoteHash;
            const cachedRemoteModTime = fileState.remoteModTime;
            
            // 🔥 1단계: 로컬 파일 변경 체크 (mtime만 사용)
            const localFileChanged = cachedLocalModTime !== currentLocalModTime;
            
            // 🔥 2단계: 원격 파일 변경 체크 (해시 비교)
            const remoteFileChanged = cachedRemoteHash !== currentRemoteHash ||
                                    cachedRemoteModTime !== currentRemoteModTime;
            
            // 둘 다 변경되지 않았으면 스킵
            if (!localFileChanged && !remoteFileChanged) {
                console.log(`⏭️ ${localFile.name}: No changes detected - skip sync`);
                console.log(`  Local mtime: ${currentLocalModTime} (cached: ${cachedLocalModTime})`);
                console.log(`  Remote hash: ${currentRemoteHash} (cached: ${cachedRemoteHash})`);
                return false;
            }
            
            // 변경 감지 로그
            if (localFileChanged) {
                console.log(`📤 ${localFile.name}: Local file changed - sync needed`);
                console.log(`  Local mtime: ${currentLocalModTime} (was: ${cachedLocalModTime})`);
            }
            
            if (remoteFileChanged) {
                console.log(`📥 ${localFile.name}: Remote file changed - sync needed`);
                console.log(`  Remote hash: ${currentRemoteHash} (was: ${cachedRemoteHash})`);
            }
            
            return true;
            
        } catch (error) {
            console.error(`❌ ${localFile.name}: Sync check error - ${error.message}`);
            return true; // 에러 시 안전하게 동기화
        }
    }

    // Google Drive 관련 메서드들
    async getOrCreateDriveFolder(): Promise<{id: string, name: string} | null> {
        try {
            console.log(`Looking for Google Drive folder: ${this.settings.driveFolder}`);

            const searchResponse = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files?q=name='${this.settings.driveFolder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                { method: 'GET' }
            );

            if (searchResponse.status === 200) {
                const searchData = searchResponse.json;
                
                if (searchData.files && searchData.files.length > 0) {
                    const folder = searchData.files[0];
                    console.log(`✓ Found existing folder: ${folder.name} (${folder.id})`);
                    return { id: folder.id, name: folder.name };
                }
            }

            console.log(`Creating new Google Drive folder: ${this.settings.driveFolder}`);
            
            const createResponse = await this.makeAuthenticatedRequest(
                'https://www.googleapis.com/drive/v3/files',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        name: this.settings.driveFolder,
                        mimeType: 'application/vnd.google-apps.folder'
                    })
                }
            );

            if (createResponse.status === 200 || createResponse.status === 201) {
                const folderData = createResponse.json;
                console.log(`✓ Created new folder: ${folderData.name} (${folderData.id})`);
                return { id: folderData.id, name: folderData.name };
            } else {
                console.error('Failed to create folder:', createResponse.status, createResponse.json);
                return null;
            }

        } catch (error) {
            console.error('Error managing Drive folder:', error);
            return null;
        }
    }

    private async syncFileToGoogleDrive(file: TFile, rootFolderId: string, baseFolder: string = ''): Promise<boolean | 'skipped'> {
        try {
            // 폴더 구조 처리 (기존 로직 유지)
            let relativePath = file.path;
            if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                relativePath = file.path.substring(baseFolder.length + 1);
            }
            
            let fileName = file.name;
            let targetFolderId = rootFolderId;
            
            if (relativePath.includes('/')) {
                const pathParts = relativePath.split('/');
                fileName = pathParts.pop()!;
                const folderPath = pathParts.join('/');
                targetFolderId = await this.getCachedFolderId(folderPath, rootFolderId);
            }
            
            // 기존 파일 확인
            const existingFile = await this.findFileInDrive(fileName, targetFolderId);
            const needsSync = await this.shouldSyncFile(file, existingFile);
            
            if (!needsSync) {
                return 'skipped';
            }

            // 파일 내용 읽기
            let content: string | ArrayBuffer;
            if (this.isTextFile(file.name)) {
                content = await this.app.vault.read(file);
            } else {
                content = await this.app.vault.readBinary(file);
            }
            
            const localModTime = file.stat.mtime;
            let success = false;
            let remoteFileData: any = null;

            if (existingFile) {
                console.log(`🔄 Updating ${file.path} in Google Drive`);
                const result = await this.updateFileInDrive(existingFile.id, content, localModTime);
                success = result.success;
                if (success) {
                    // 업데이트된 파일 정보 가져오기
                    remoteFileData = await this.getUpdatedFileInfo(existingFile.id);
                }
            } else {
                console.log(`📤 Uploading ${file.path} to Google Drive`);
                const result = await this.uploadFileToDrive(fileName, content, targetFolderId, localModTime);
                success = result.success;
                remoteFileData = result.fileData;
            }

            // 🔥 성공 시 상태 캐시 업데이트 (mtime + 원격 해시)
            if (success && remoteFileData) {
                this.setFileState(file.path, {
                    localModTime: localModTime,  // 🔥 로컬은 mtime만
                    remoteHash: remoteFileData.md5Checksum,  // 🔥 원격은 해시
                    remoteModTime: new Date(remoteFileData.modifiedTime).getTime(),
                    lastSyncTime: Date.now(),
                    version: remoteFileData.version
                });
                
                await this.saveSettings();
                console.log(`💾 State cached for ${file.path}: localMtime=${localModTime}, remoteHash=${remoteFileData.md5Checksum}`);
            }

            return success;

        } catch (error) {
            console.error(`❌ Failed to sync ${file.path}:`, error);
            return false;
        }
    }

    private async getUpdatedFileInfo(fileId: string): Promise<any> {
        try {
            const params = new URLSearchParams({
                fields: 'id,name,modifiedTime,md5Checksum,version,size',
                supportsAllDrives: 'true'
            });
            
            const response = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
                { method: 'GET' }
            );
            
            if (response.status === 200) {
                return response.json;
            }
            
            throw new Error(`Failed to get file info: ${response.status}`);
        } catch (error) {
            console.error('Error getting updated file info:', error);
            throw error;
        }
    }

    shouldSyncFileType(file: TFile): boolean {
        // 텍스트 파일 확장자
        const textExtensions = ['.md', '.txt', '.json', '.csv', '.html', '.css', '.js'];
        
        // 바이너리 파일 확장자 (Obsidian에서 일반적으로 사용되는 것들)
        const binaryExtensions = ['.pdf', '.docx', '.pptx', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
        
        const excludePatterns = [
            /^\./, // 숨김 파일
            /\.tmp$/, // 임시 파일
            /\.bak$/, // 백업 파일
            /\.lock$/, // 락 파일
        ];
    
        const hasValidExtension = [...textExtensions, ...binaryExtensions].some(ext => file.name.endsWith(ext));
        const shouldExclude = excludePatterns.some(pattern => pattern.test(file.name));
    
        return hasValidExtension && !shouldExclude;
    }
    private isTextFile(fileName: string): boolean {
        const textExtensions = ['.md', '.txt', '.json', '.csv', '.html', '.css', '.js'];
        return textExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
    }
    
    private isBinaryFile(fileName: string): boolean {
        const binaryExtensions = ['.pdf', '.docx', '.pptx', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
        return binaryExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
    }

    private async getFileContentFromDrive(fileId: string, fileName?: string): Promise<string | ArrayBuffer> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                { method: 'GET' }
            );

            if (response.status === 200) {
                // 파일명이 제공된 경우 형식에 따라 처리
                if (fileName && this.isBinaryFile(fileName)) {
                    // 바이너리 파일인 경우 ArrayBuffer 반환
                    return response.arrayBuffer;
                } else {
                    // 텍스트 파일인 경우 문자열 반환
                    const decoder = new TextDecoder('utf-8');
                    return decoder.decode(response.arrayBuffer);
                }
            } else {
                throw new Error(`Failed to download file: ${response.status}`);
            }
        } catch (error) {
            console.error('Error downloading file from Drive:', error);
            throw error;
        }
    }



    private async findFolderInDrive(itemName: string, parentFolderId?: string): Promise<{id: string, name: string} | null> {
        try {
            // 폴더, 바로가기, 공유 드라이브 모두 검색
            let query = `name='${itemName}' and trashed=false and (mimeType='application/vnd.google-apps.folder' or mimeType='application/vnd.google-apps.drive-sdk')`;
            
            if (parentFolderId) {
                query += ` and '${parentFolderId}' in parents`;
            }
            
            const params = new URLSearchParams({
                q: query,
                fields: 'files(id,name,mimeType)',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true'
            });
    
            const response = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
                { method: 'GET' }
            );
    
            if (response.status === 200) {
                const data = response.json;
                if (data.files && data.files.length > 0) {
                    const found = data.files[0];
                    
                    let resultItem = {
                        id: found.id,
                        name: found.name,
                        type: found.mimeType
                    };
                    
                    
                    console.log(`항목 발견: ${resultItem.name} (타입: ${resultItem.type})`);
                    return resultItem;
                }
            }
            return null;
        } catch (error) {
            console.error('Error searching item in Drive:', error);
            throw error;
        }
    }

    private async createFolderInDrive(folderName: string, parentFolderId: string): Promise<{id: string, name: string} | null> {
        try {
            const response = await this.makeAuthenticatedRequest(
                'https://www.googleapis.com/drive/v3/files',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        name: folderName,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [parentFolderId]
                    })
                }
            );
    
            if (response.status === 200 || response.status === 201) {
                const folderData = response.json;
                return { id: folderData.id, name: folderData.name };
            } else {
                console.error('Failed to create folder:', response.status, response.json);
                return null;
            }
        } catch (error) {
            console.error('Error creating folder in Drive:', error);
            throw error;
        }
    }

    private async findFileInDrive(fileName: string, folderId: string): Promise<any | null> {
        try {
            const params = new URLSearchParams({
                q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
                fields: 'files(id,name,modifiedTime,md5Checksum,version,size)', // 🔥 필요한 필드만 요청
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true'
            });
            
            const response = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
                { method: 'GET' }
            );

            if (response.status === 200) {
                const data = response.json;
                if (data.files && data.files.length > 0) {
                    const file = data.files[0];
                    console.log(`🔍 Found remote file: ${fileName}, hash: ${file.md5Checksum || 'none'}, modified: ${file.modifiedTime}`);
                    return file;
                }
            }
            return null;
        } catch (error) {
            console.error('Error searching file in Drive:', error);
            throw error;
        }
    }


    private async updateFileInDrive(fileId: string, content: string | ArrayBuffer, localModTime: number): Promise<{success: boolean, fileData?: any}> {
        try {
            // 파일 내용 업데이트
            let contentResponse;
            
            if (typeof content === 'string') {
                contentResponse = await this.makeAuthenticatedRequest(
                    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'text/plain' },
                        body: content
                    }
                );
            } else {
                contentResponse = await this.makeAuthenticatedRequest(
                    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: content
                    }
                );
            }

            if (contentResponse.status !== 200) {
                return { success: false };
            }

            // 메타데이터 업데이트 및 최신 정보 가져오기
            const metadataResponse = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,modifiedTime,md5Checksum,version,size`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        modifiedTime: new Date(localModTime).toISOString()
                    })
                }
            );

            const success = metadataResponse.status === 200;
            
            if (success) {
                const fileData = metadataResponse.json;
                console.log(`🔄 File updated with hash ${fileData.md5Checksum || 'none'} at ${new Date(localModTime).toLocaleString()}`);
                return { success: true, fileData: fileData };
            }
            
            return { success: false };
        } catch (error) {
            console.error(`❌ Update failed - ${error.message}`);
            return { success: false };
        }
    }

    setupAutoSync() {
        console.log('=== Setting up Auto Sync ===');
        console.log(`Auto sync enabled: ${this.settings.autoSync}`);
        console.log(`Sync interval: ${this.settings.syncInterval}ms (${this.settings.syncInterval / 60000} minutes)`);
        
        // 기존 interval 정리
        if (this.syncIntervalId) {
            console.log(`Clearing existing interval: ${this.syncIntervalId}`);
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }

        // Auto sync가 활성화된 경우에만 새 interval 설정
        if (this.settings.autoSync) {
            console.log(`Setting new auto sync interval: ${this.settings.syncInterval}ms`);
            this.syncIntervalId = window.setInterval(() => {
                console.log(`🔄 Auto sync triggered at ${new Date().toLocaleString()}`);
                this.mainSync(false);
            }, this.settings.syncInterval);
            
            console.log(`✅ Auto sync active with interval ID: ${this.syncIntervalId}`);
        } else {
            console.log('❌ Auto sync is disabled - no interval set');
        }
        
        console.log(`Final auto sync status: ${this.isAutoSyncActive()}`);
    }

    resetGoogleAPIState() {
        console.log('Resetting Google API state...');
        this.isGoogleApiLoaded = false;
        console.log('Google API state reset completed');
    }
    async mainSync(showProgress: boolean = true): Promise<SyncResult> {
        if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.apiKey) {
            new Notice('Please configure Google Drive API credentials in settings');
            return this.createEmptyResult();
        }
    
        if (!this.settings.syncWholeVault && this.settings.selectedDriveFolders.length === 0) {
            new Notice('Please select Google Drive folders to sync or enable "Sync Whole Vault" in settings');
            return this.createEmptyResult();
        }
    
        // 진행 상황을 표시하지 않는 경우에만 간단한 알림
        if (!showProgress) {
            new Notice('Starting Google Drive sync...');
        }
    
        try {
            if (!this.isAuthenticated()) {
                const message = 'Please authenticate first using the Desktop App method.';
                new Notice(`❌ ${message}`);
                return this.createEmptyResult();
            }
    
            let result: SyncResult;
    
            // 설정된 sync direction에 따라 실행
            if (this.settings.syncDirection === 'upload') {
                result = await this.uploadToGoogleDrive(showProgress);
            } else if (this.settings.syncDirection === 'download') {
                result = await this.downloadFromGoogleDrive(showProgress);
            } else {
                result = await this.bidirectionalSync(showProgress);
            }
    
            return result;
    
        } catch (error) {
            console.error('Sync failed:', error);
            new Notice('❌ Google Drive sync failed');
            return this.createEmptyResult();
        }
    }
       
    async testDriveAPIConnection(): Promise<boolean> {
        try {
            if (!this.isAuthenticated()) {
                console.log('No tokens available for testing');
                new Notice('❌ Please authenticate first');
                return false;
            }

            console.log('Testing Google Drive API connection...');
            
            const response = await this.makeAuthenticatedRequest(
                'https://www.googleapis.com/drive/v3/about?fields=user',
                { method: 'GET' }
            );

            console.log('API Response Status:', response.status);

            if (response.status === 200) {
                const data = response.json;
                console.log('Drive API test successful:', data);
                
                const expiresAt = this.settings.tokenExpiresAt;
                const expiresText = expiresAt > 0 ? 
                    `Token expires: ${new Date(expiresAt).toLocaleString()}` : 
                    'Token expiration unknown';
                
                new Notice(`✅ Drive API connection successful. User: ${data.user?.displayName || 'Unknown'}. ${expiresText}`);
                return true;
            } else if (response.status === 401) {
                console.error('Authentication failed - Attempting token refresh...');
                
                // 토큰 갱신 시도
                const refreshed = await this.refreshAccessToken();
                if (refreshed) {
                    new Notice('🔄 Token refreshed successfully. Please try again.');
                    return await this.testDriveAPIConnection(); // 재귀 호출
                } else {
                    new Notice('❌ Authentication expired and refresh failed. Please sign in again.');
                    return false;
                }
            } else if (response.status === 403) {
                console.error('API access denied - Check API key and permissions');
                new Notice('❌ API access denied. Check your API Key and Drive API is enabled.');
                return false;
            } else {
                console.error(`Drive API test failed: ${response.status}`);
                new Notice(`❌ Drive API connection failed (Status: ${response.status}). Check console for details.`);
                return false;
            }

        } catch (error) {
            console.error('Drive API test error:', error);
            new Notice('❌ Unexpected error occurred. Check console for details.');
            return false;
        }
    }
}

class GDriveSyncSettingTab extends PluginSettingTab {
    plugin: GDriveSyncPlugin;

    constructor(app: App, plugin: GDriveSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.plugin.settingTab = this;
    }

    public refreshDisplay(): void {
        this.display();
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Header
        containerEl.createEl('h2', { text: 'Google Drive Sync' });

        // Status indicator at the top
        this.createStatusSection(containerEl);

        // Authentication section
        this.createAuthSection(containerEl);

        // Sync configuration section
        this.createSyncSection(containerEl);

        // Advanced settings section
        this.createAdvancedSection(containerEl);

        // Debug section
        this.createDebugSection(containerEl);
    }

    private createStatusSection(containerEl: HTMLElement): void {
        const statusSetting = new Setting(containerEl)
            .setName('Connection Status')
            .setDesc('Current Google Drive connection status');

        const isAuth = this.plugin.isAuthenticated();
        const hasRefreshToken = !!this.plugin.settings.refreshToken;
        
        if (isAuth && hasRefreshToken) {
            const expiresAt = this.plugin.settings.tokenExpiresAt;
            if (expiresAt > 0) {
                const now = Date.now();
                const minutesUntilExpiry = Math.round((expiresAt - now) / (1000 * 60));
                
                if (now >= expiresAt) {
                    statusSetting.setDesc('🔄 Token expired - will refresh automatically');
                } else if (minutesUntilExpiry < 10) {
                    statusSetting.setDesc(`⏰ Token expires in ${minutesUntilExpiry} minutes`);
                } else {
                    statusSetting.setDesc(`✅ Connected - expires ${new Date(expiresAt).toLocaleTimeString()}`);
                }
            } else {
                statusSetting.setDesc('✅ Connected with long-term authentication');
            }
        } else {
            statusSetting.setDesc('❌ Not authenticated - please sign in');
        }

        // Quick sync button
        statusSetting.addButton(button => button
            .setButtonText('Sync Now')
            .setCta()
            .onClick(() => this.plugin.mainSync(true)));
    }

    private createAuthSection(containerEl: HTMLElement): void {
        containerEl.createEl('h3', { text: 'Authentication' });

        // API Credentials
        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('Google Cloud Console OAuth 2.0 Client ID')
            .addText(text => text
                .setPlaceholder('Enter your Client ID')
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Client Secret')
            .setDesc('Google Cloud Console OAuth 2.0 Client Secret')
            .addText(text => text
                .setPlaceholder('Enter your Client Secret')
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('Google Cloud Console API Key for Google Drive API')
            .addText(text => text
                .setPlaceholder('Enter your API Key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        // Authentication actions
        new Setting(containerEl)
            .setName('Authentication')
            .setDesc('Sign in to Google Drive')
            .addButton(button => button
                .setButtonText('Authenticate')
                .setCta()
                .onClick(() => this.plugin.authenticateGoogleDrive()))
            .addButton(button => button
                .setButtonText('Test Connection')
                .onClick(() => this.plugin.testDriveAPIConnection()))
            .addButton(button => button
                .setButtonText('Refresh Token')
                .onClick(async () => {
                    const success = await this.plugin.refreshAccessToken();
                    if (success) {
                        new Notice('✅ Token refreshed successfully');
                        this.display();
                    }
                }))
            .addButton(button => button
                .setButtonText('Sign Out')
                .setWarning()
                .onClick(async () => {
                    await this.plugin.revokeGoogleDriveAccess();
                }));

        // 🔥 Authorization code input (only shown when not authenticated)
        if (!this.plugin.isAuthenticated()) {
            new Setting(containerEl)
                .setName('Authorization Code')
                .setDesc('After clicking "Authenticate", paste the authorization code from Google here')
                .addText(text => {
                    text.setPlaceholder('Paste authorization code...');
                    
                    // Store reference for the exchange button
                    this.authCodeInput = text;
                    
                    return text;
                })
                .addButton(button => button
                    .setButtonText('Exchange for Token')
                    .setCta()
                    .onClick(async () => {
                        const authCode = this.authCodeInput?.inputEl.value?.trim();
                        
                        if (!authCode) {
                            new Notice('❌ Please enter authorization code first');
                            this.authCodeInput?.inputEl.focus();
                            return;
                        }
                        
                        // Disable button during processing
                        button.setButtonText('Exchanging...');
                        button.setDisabled(true);
                        
                        try {
                            const success = await this.plugin.exchangeCodeForToken(authCode);
                            if (success) {
                                this.authCodeInput?.setValue('');
                                this.display(); // Refresh the entire settings display
                            }
                        } finally {
                            button.setButtonText('Exchange for Token');
                            button.setDisabled(false);
                        }
                    }));
        }
    }

    private createSyncSection(containerEl: HTMLElement): void {
        containerEl.createEl('h3', { text: 'Sync Configuration' });

        // Sync whole vault toggle
        new Setting(containerEl)
            .setName('Sync Whole Vault')
            .setDesc('Sync your entire vault with Google Drive root folder')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncWholeVault)
                .onChange(async (value) => {
                    this.plugin.settings.syncWholeVault = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // Folder selection (only if not syncing whole vault)
        if (!this.plugin.settings.syncWholeVault) {
            new Setting(containerEl)
                .setName('Google Drive Folders')
                .setDesc('Select folders to sync with Google Drive')
                .addButton(button => button
                    .setButtonText('Browse Google Drive')
                    .onClick(() => this.openDriveFolderSelector()));

            // Show selected folders
            if (this.plugin.settings.selectedDriveFolders.length > 0) {
                const folderListEl = containerEl.createEl('div', { 
                    attr: { style: 'margin-left: 20px; margin-bottom: 20px;' }
                });
                
                folderListEl.createEl('h4', { text: 'Selected Folders:' });
                
                this.plugin.settings.selectedDriveFolders.forEach((folder, index) => {
                    const folderSetting = new Setting(folderListEl)
                        .setName(folder.name)
                        .setDesc(`Path: ${folder.path || '/'}`)
                        .addButton(button => button
                            .setButtonText('Remove')
                            .setWarning()
                            .onClick(async () => {
                                this.plugin.settings.selectedDriveFolders.splice(index, 1);
                                await this.plugin.saveSettings();
                                this.display();
                                new Notice(`Removed: ${folder.name}`);
                            }));
                });
            } else {
                const noFoldersEl = containerEl.createEl('div', { 
                    text: 'No folders selected. Click "Browse Google Drive" to select folders.',
                    attr: { 
                        style: 'margin-left: 20px; margin-bottom: 20px; color: var(--text-muted); font-style: italic;'
                    }
                });
            }
        }

        // Sync direction
        new Setting(containerEl)
            .setName('Sync Direction')
            .setDesc('Choose how files should be synchronized')
            .addDropdown(dropdown => dropdown
                .addOption('bidirectional', '🔄 Bidirectional (Upload & Download)')
                .addOption('upload', '📤 Upload Only (Local → Drive)')
                .addOption('download', '📥 Download Only (Drive → Local)')
                .setValue(this.plugin.settings.syncDirection)
                .onChange(async (value: 'upload' | 'download' | 'bidirectional') => {
                    this.plugin.settings.syncDirection = value;
                    await this.plugin.saveSettings();
                }));

        // Conflict resolution
        new Setting(containerEl)
            .setName('Conflict Resolution')
            .setDesc('How to handle conflicts when both local and remote files exist')
            .addDropdown(dropdown => dropdown
                .addOption('newer', '🕒 Use Newer File (recommended)')
                .addOption('local', '📱 Always Use Local File')
                .addOption('remote', '☁️ Always Use Remote File')
                .addOption('ask', '❓ Ask User (manual resolution)')
                .setValue(this.plugin.settings.conflictResolution)
                .onChange(async (value: 'local' | 'remote' | 'newer' | 'ask') => {
                    this.plugin.settings.conflictResolution = value;
                    await this.plugin.saveSettings();
                }));

        // Include subfolders
        new Setting(containerEl)
            .setName('Include Subfolders')
            .setDesc('Recursively sync files from subfolders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeSubfolders)
                .onChange(async (value) => {
                    this.plugin.settings.includeSubfolders = value;
                    await this.plugin.saveSettings();
                }));

        // Create missing folders
        new Setting(containerEl)
            .setName('Create Missing Folders')
            .setDesc('Automatically create local folders when downloading from Google Drive')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createMissingFolders)
                .onChange(async (value) => {
                    this.plugin.settings.createMissingFolders = value;
                    await this.plugin.saveSettings();
                }));
    }

    private createAdvancedSection(containerEl: HTMLElement): void {
        containerEl.createEl('h3', { text: 'Advanced Settings' });

        // Auto sync
        const autoSyncSetting = new Setting(containerEl)
            .setName('Auto Sync')
            .setDesc('Automatically sync at regular intervals')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        this.plugin.setupAutoSync();
                        new Notice('✅ Auto sync enabled');
                    } else {
                        this.plugin.stopAutoSync();
                        new Notice('❌ Auto sync disabled');
                    }
                    
                    this.updateAutoSyncStatus();
                }));

        // Add auto sync status to description
        this.updateAutoSyncStatus(autoSyncSetting);

        // Sync interval
        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('How often to sync (in minutes)')
            .addSlider(slider => {
                const currentValue = this.plugin.settings.syncInterval / 60000;
                return slider
                    .setLimits(1, 60, 1)
                    .setValue(currentValue)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.syncInterval = value * 60000;
                        await this.plugin.saveSettings();
                        
                        // Update description
                        const setting = slider.sliderEl.closest('.setting-item') as HTMLElement;
                        if (setting) {
                            const desc = setting.querySelector('.setting-item-description') as HTMLElement;
                            if (desc) {
                                desc.textContent = `How often to sync: ${value} minute${value !== 1 ? 's' : ''}`;
                            }
                        }
                        
                        if (this.plugin.settings.autoSync) {
                            this.plugin.setupAutoSync();
                            new Notice(`Auto sync interval updated to ${value} minute${value !== 1 ? 's' : ''}`);
                        }
                    });
            });

        // Root folder name
        new Setting(containerEl)
            .setName('Root Folder Name')
            .setDesc('Name of the root folder in Google Drive')
            .addText(text => text
                .setPlaceholder('e.g., Obsidian-Sync')
                .setValue(this.plugin.settings.driveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.driveFolder = value;
                    await this.plugin.saveSettings();
                }));
    }

    private createDebugSection(containerEl: HTMLElement): void {
        containerEl.createEl('h3', { text: 'Troubleshooting & Debug' });

        // Troubleshooting actions
        new Setting(containerEl)
            .setName('Cache Management')
            .setDesc('Clear internal caches to resolve sync issues')
            .addButton(button => button
                .setButtonText('Clear Cache')
                .onClick(() => {
                    this.plugin.clearFileStateCache();
                }))
            .addButton(button => button
                .setButtonText('Debug Auto Sync')
                .onClick(() => {
                    this.plugin.debugAutoSyncStatus();
                }));                 

        // Export/Import settings
        new Setting(containerEl)
            .setName('Settings Management')
            .setDesc('Export or reset plugin settings')
            .addButton(button => button
                .setButtonText('Export Settings')
                .onClick(() => {
                    const settings = {
                        ...this.plugin.settings,
                        // Remove sensitive data
                        accessToken: '',
                        refreshToken: '',
                        clientSecret: ''
                    };
                    navigator.clipboard.writeText(JSON.stringify(settings, null, 2));
                    new Notice('📋 Settings exported to clipboard (sensitive data removed)');
                }))
            .addButton(button => button
                .setButtonText('Reset Settings')
                .setWarning()
                .onClick(async () => {
                    if (confirm('Are you sure you want to reset all settings? This cannot be undone.')) {
                        Object.assign(this.plugin.settings, {
                            clientId: '',
                            clientSecret: '',
                            apiKey: '',
                            syncFolders: [],
                            syncWholeVault: false,
                            autoSync: false,
                            syncInterval: 300000,
                            accessToken: '',
                            refreshToken: '',
                            tokenExpiresAt: 0,
                            driveFolder: 'Obsidian-Sync',
                            includeSubfolders: true,
                            lastSyncTime: 0,
                            syncDirection: 'bidirectional',
                            conflictResolution: 'newer',
                            createMissingFolders: true,
                            selectedDriveFolders: [],
                            fileStateCache: {}
                        });
                        await this.plugin.saveSettings();
                        this.display();
                        new Notice('⚠️ Settings reset to defaults');
                    }
                }));

        // Debug information
        const debugInfo = {
            authenticated: this.plugin.isAuthenticated(),
            hasRefreshToken: !!this.plugin.settings.refreshToken,
            tokenExpires: this.plugin.settings.tokenExpiresAt > 0 ? 
                new Date(this.plugin.settings.tokenExpiresAt).toLocaleString() : 'Unknown',
            selectedFolders: this.plugin.settings.selectedDriveFolders.length,
            lastSync: this.plugin.settings.lastSyncTime > 0 ? 
                new Date(this.plugin.settings.lastSyncTime).toLocaleString() : 'Never',
            autoSyncActive: this.plugin.isAutoSyncActive(),
            syncIntervalMinutes: this.plugin.settings.syncInterval / 60000
        };

        const debugSetting = new Setting(containerEl)
            .setName('Debug Information')
            .setDesc('Current plugin status and configuration');

        const debugEl = debugSetting.settingEl.createEl('details');
        const summaryEl = debugEl.createEl('summary', { text: 'Show Debug Info' });
        const preEl = debugEl.createEl('pre', { 
            text: JSON.stringify(debugInfo, null, 2),
            attr: { 
                style: 'background: var(--background-primary-alt); padding: 10px; border-radius: 4px; font-size: 12px; overflow-x: auto;'
            }
        });
    }

    private updateAutoSyncStatus(setting?: Setting): void {
        if (!setting) {
            // Find the auto sync setting
            const autoSyncEl = document.querySelector('.setting-item-name:contains("Auto Sync")')?.closest('.setting-item') as HTMLElement;
            if (!autoSyncEl) return;
            
            const descEl = autoSyncEl.querySelector('.setting-item-description') as HTMLElement;
            if (descEl) {
                this.updateAutoSyncDescription(descEl);
            }
        } else {
            this.updateAutoSyncDescription(setting.descEl);
        }
    }

    private updateAutoSyncDescription(descEl: HTMLElement): void {
        const isActive = this.plugin.isAutoSyncActive();
        const intervalMinutes = this.plugin.settings.syncInterval / 60000;
        
        let baseDesc = 'Automatically sync at regular intervals';
        let statusText = '';
        
        if (this.plugin.settings.autoSync && isActive) {
            statusText = ` ✅ Active - syncing every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}`;
        } else if (this.plugin.settings.autoSync && !isActive) {
            statusText = ' ⚠️ Enabled but not running';
        } else {
            statusText = ' ❌ Disabled';
        }
        
        descEl.textContent = baseDesc + statusText;
    }

    private async openDriveFolderSelector(): Promise<void> {
        if (!this.plugin.isAuthenticated()) {
            new Notice('❌ Please authenticate with Google Drive first');
            return;
        }

        const modal = new DriveFolderModal(this.app, this.plugin, async (selectedFolder) => {
            // Check if already selected
            const alreadySelected = this.plugin.settings.selectedDriveFolders.some(
                folder => folder.id === selectedFolder.id
            );
            
            if (alreadySelected) {
                new Notice(`Folder "${selectedFolder.name}" is already selected`);
                return;
            }
            
            // Add selected folder
            this.plugin.settings.selectedDriveFolders.push({
                id: selectedFolder.id,
                name: selectedFolder.name,
                path: selectedFolder.path
            });
            
            await this.plugin.saveSettings();
            this.display(); // Refresh the settings display
            new Notice(`✅ Added Google Drive folder: ${selectedFolder.name}`);
        });
        
        modal.open();
    }

    hide(): void {
        if (this.plugin.settingTab === this) {
            this.plugin.settingTab = null;
        }
    }

    private authCodeInput?: TextComponent;
}