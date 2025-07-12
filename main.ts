import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, requestUrl, FuzzySuggestModal, Modal } from 'obsidian';

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
    syncMode: 'always' | 'modified' | 'checksum';
    lastSyncTime: number;
    syncDirection: 'upload' | 'download' | 'bidirectional';
    conflictResolution: 'local' | 'remote' | 'newer' | 'ask';
    createMissingFolders: boolean;
    selectedDriveFolders: Array<{id: string, name: string, path: string}>; // 선택된 Google Drive 폴더 정보
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
    syncMode: 'modified',
    lastSyncTime: 0,
    syncDirection: 'bidirectional',
    conflictResolution: 'newer',
    createMissingFolders: true,
    selectedDriveFolders: []
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
    private progressEl: HTMLElement;
    private statusEl: HTMLElement;
    private logEl: HTMLElement;
    private progressBar: HTMLElement;
    private cancelButton: HTMLButtonElement;
    private closeButton: HTMLButtonElement;
    private isCompleted = false;
    private isCancelled = false;
    private logs: string[] = [];

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // 헤더
        const header = contentEl.createEl('div', { 
            attr: { style: 'display: flex; align-items: center; margin-bottom: 20px;' }
        });
        
        header.createEl('h2', { 
            text: 'Google Drive Sync Progress',
            attr: { style: 'margin: 0; flex-grow: 1;' }
        });

        // 진행률 섹션
        const progressSection = contentEl.createEl('div', {
            attr: { style: 'margin-bottom: 20px;' }
        });

        // 진행률 바 컨테이너
        const progressContainer = progressSection.createEl('div', {
            attr: { 
                style: 'background-color: var(--background-modifier-border); border-radius: 10px; height: 20px; margin-bottom: 10px; overflow: hidden;' 
            }
        });

        // 진행률 바
        this.progressBar = progressContainer.createEl('div', {
            attr: { 
                style: 'background: linear-gradient(90deg, #4CAF50, #45a049); height: 100%; width: 0%; transition: width 0.3s ease; border-radius: 10px;' 
            }
        });

        // 진행률 텍스트
        this.progressEl = progressSection.createEl('div', { 
            text: '0%',
            attr: { style: 'text-align: center; font-weight: bold; color: var(--text-accent);' }
        });

        // 상태 표시
        this.statusEl = contentEl.createEl('div', { 
            text: 'Initializing sync...',
            attr: { 
                style: 'margin: 15px 0; padding: 10px; background-color: var(--background-secondary); border-radius: 5px; font-weight: bold;' 
            }
        });

        // 로그 섹션
        const logSection = contentEl.createEl('div', {
            attr: { style: 'margin: 20px 0;' }
        });
        
        logSection.createEl('h4', { 
            text: 'Sync Log:',
            attr: { style: 'margin-bottom: 10px;' }
        });

        this.logEl = logSection.createEl('div', {
            attr: { 
                style: 'max-height: 200px; overflow-y: auto; background-color: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); border-radius: 5px; padding: 10px; font-family: monospace; font-size: 12px; line-height: 1.4;' 
            }
        });

        // 버튼 섹션
        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'text-align: right; margin-top: 20px; border-top: 1px solid var(--background-modifier-border); padding-top: 15px;' }
        });

        this.cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel',
            cls: 'mod-warning',
            attr: { style: 'margin-right: 10px;' }
        });

        this.closeButton = buttonContainer.createEl('button', { 
            text: 'Close',
            cls: 'mod-cta'
        });
        this.closeButton.style.display = 'none'; // 초기에는 숨김

        // 이벤트 핸들러
        this.cancelButton.onclick = () => {
            if (!this.isCompleted) {
                this.isCancelled = true;
                this.updateStatus('🛑 Cancelling sync...', 'warning');
                this.cancelButton.disabled = true;
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
            this.updateStatus(`🔄 ${operation}`, 'info');
        }
    }

    updateStatus(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
        if (this.isCancelled && type !== 'warning') return;

        const icons = {
            info: '💬',
            success: '✅',
            warning: '⚠️',
            error: '❌'
        };

        const colors = {
            info: 'var(--text-normal)',
            success: '#4CAF50',
            warning: '#FF9800',
            error: '#F44336'
        };

        this.statusEl.textContent = `${icons[type]} ${message}`;
        this.statusEl.style.color = colors[type];
    }

    addLog(message: string) {
        if (this.isCancelled) return;
    
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        this.logs.push(logEntry);
        
        const logLine = this.logEl.createEl('div', { 
            text: logEntry,
            attr: { style: 'margin-bottom: 2px;' }
        });
        
        // 🎨 로그 타입별 색상 구분
        if (message.includes('⚡ Conflict')) {
            logLine.style.color = '#FF9800'; // 주황색
        } else if (message.includes('✅')) {
            logLine.style.color = '#4CAF50'; // 녹색
        } else if (message.includes('❌')) {
            logLine.style.color = '#F44336'; // 빨간색
        } else if (message.includes('⏭️')) {
            logLine.style.color = '#9E9E9E'; // 회색
        } else if (message.includes('🔍')) {
            logLine.style.color = '#2196F3'; // 파란색
        }
        
        // 자동 스크롤
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    markCompleted(result: SyncResult) {
        this.isCompleted = true;
        this.progressBar.style.width = '100%';
        this.progressEl.textContent = '100% - Completed';

        // 결과 요약
        const hasErrors = result.errors > 0;
        const resultIcon = hasErrors ? '⚠️' : '✅';
        const resultColor = hasErrors ? '#FF9800' : '#4CAF50';
        
        const summary = [
            `${result.uploaded} uploaded`,
            `${result.downloaded} downloaded`,
            `${result.skipped} skipped`,
            result.conflicts > 0 ? `${result.conflicts} conflicts` : '',
            result.errors > 0 ? `${result.errors} errors` : ''
        ].filter(Boolean).join(', ');

        this.updateStatus(`${resultIcon} Sync completed: ${summary}`, hasErrors ? 'warning' : 'success');
        
        // 상세 결과 로그 추가
        this.addLog('=== SYNC COMPLETED ===');
        this.addLog(`📤 Uploaded: ${result.uploaded} files`);
        this.addLog(`📥 Downloaded: ${result.downloaded} files`);
        this.addLog(`⏭️ Skipped: ${result.skipped} files`);
        if (result.conflicts > 0) this.addLog(`⚡ Conflicts resolved: ${result.conflicts}`);
        if (result.errors > 0) this.addLog(`❌ Errors: ${result.errors}`);
        if (result.createdFolders.length > 0) {
            this.addLog(`📁 Created folders: ${result.createdFolders.length}`);
            result.createdFolders.forEach(folder => this.addLog(`  - ${folder}`));
        }

        // 버튼 상태 변경
        this.cancelButton.style.display = 'none';
        this.closeButton.style.display = 'inline-block';
    }

    markCancelled() {
        this.isCancelled = true;
        this.updateStatus('🛑 Sync cancelled by user', 'warning');
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

// 폴더 생성 모달
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

        const form = contentEl.createEl('div', { 
            attr: { style: 'margin: 20px 0;' }
        });

        const inputLabel = form.createEl('label', { 
            text: 'Folder Name:',
            attr: { style: 'display: block; margin-bottom: 8px; font-weight: bold;' }
        });

        const folderInput = form.createEl('input', {
            type: 'text',
            placeholder: 'Enter folder name...',
            attr: { 
                style: 'width: 100%; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin-bottom: 15px;'
            }
        });

        // 입력 필드에 포커스
        folderInput.focus();

        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'text-align: right; margin-top: 20px; border-top: 1px solid var(--background-modifier-border); padding-top: 15px;' }
        });

        const createButton = buttonContainer.createEl('button', { 
            text: 'Create Folder',
            cls: 'mod-cta',
            attr: { style: 'margin-right: 10px;' }
        });

        const cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel'
        });

        // 이벤트 핸들러
        const handleSubmit = () => {
            const folderName = folderInput.value.trim();
            if (!folderName) {
                new Notice('❌ Please enter a folder name');
                folderInput.focus();
                return;
            }

            // 유효한 폴더명인지 검사
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

        // Enter 키로 제출
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

// Google Drive 폴더 선택 모달
class DriveFolderModal extends Modal {
    private plugin: GDriveSyncPlugin;
    private onChoose: (folder: DriveFolder) => void;
    private folders: DriveFolder[] = [];
    private folderListItems: FolderListItem[] = []; // 새로 추가
    
    constructor(app: App, plugin: GDriveSyncPlugin, onChoose: (folder: DriveFolder) => void) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
    
        contentEl.createEl('h2', { text: 'Select Google Drive Folder' });
        
        const loadingEl = contentEl.createEl('div', { text: 'Loading Google Drive folders...' });
        
        try {
            await this.loadDriveFolders();
            loadingEl.remove();
            this.renderFolderList(contentEl); // 메서드명 변경
        } catch (error) {
            loadingEl.textContent = 'Failed to load folders. Please check your authentication.';
            console.error('Error loading Drive folders:', error);
        }
    
        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'text-align: right; margin-top: 15px; border-top: 1px solid var(--background-modifier-border); padding-top: 15px;' }
        });
    
        const createFolderButton = buttonContainer.createEl('button', { 
            text: '+ Create New Folder',
            cls: 'mod-cta',
            attr: { style: 'margin-right: 10px;' }
        });
        createFolderButton.onclick = () => this.showCreateFolderDialog();
    
        const refreshButton = buttonContainer.createEl('button', { 
            text: '🔄 Refresh',
            attr: { style: 'margin-right: 10px;' }
        });
        refreshButton.onclick = () => this.refreshFolders();
    
        const cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel'
        });
        cancelButton.onclick = () => this.close();
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
    
    private async refreshFolders(): Promise<void> {
        try {
            const loadingEl = document.querySelector('.folder-list-container .loading');
            if (loadingEl) {
                loadingEl.textContent = 'Refreshing...';
            }
    
            await this.loadDriveFolders();
            this.refreshFolderList();
    
            if (loadingEl) {
                loadingEl.remove();
            }
    
            new Notice('✅ Folder list refreshed');
        } catch (error) {
            console.error('Error refreshing folders:', error);
            new Notice('❌ Failed to refresh folders');
        }
    }

    private renderFolderList(container: HTMLElement) {
        const listContainer = container.createEl('div', { 
            cls: 'folder-list-container',
            attr: { 
                style: 'max-height: 400px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 10px; margin: 10px 0;' 
            }
        });
    
        this.folderListItems = this.createFolderListItems();
    
        if (this.folderListItems.length === 0) {
            listContainer.createEl('p', { 
                text: 'No folders found in Google Drive root folder.',
                attr: { style: 'text-align: center; color: var(--text-muted); margin: 20px 0;' }
            });
            return;
        }
    
        // 폴더 상태별 정렬: 선택된 폴더 먼저, 그 다음 이름순
        const sortedFolders = this.folderListItems.sort((a, b) => {
            if (a.isSelected && !b.isSelected) return -1;
            if (!a.isSelected && b.isSelected) return 1;
            return a.name.localeCompare(b.name);
        });
    
        sortedFolders.forEach(folderItem => {
            this.renderFolderItem(listContainer, folderItem);
        });
    }
    
    private refreshFolderList(): void {
        const existingContainer = document.querySelector('.folder-list-container');
        if (existingContainer) {
            existingContainer.remove();
        }
        
        const contentEl = this.containerEl.querySelector('.modal-content') as HTMLElement;
        const buttonsContainer = contentEl.querySelector('div[style*="text-align: right"]') as HTMLElement;
        
        this.renderFolderList(contentEl);
        
        // 버튼을 다시 마지막에 추가
        if (buttonsContainer) {
            contentEl.appendChild(buttonsContainer);
        }
    }

    private renderFolderItem(container: HTMLElement, folderItem: FolderListItem) {
        const itemEl = container.createEl('div', { 
            cls: `folder-list-item ${folderItem.isSelected ? 'selected' : 'available'}`,
            attr: { 
                style: `
                    display: flex; 
                    align-items: center; 
                    padding: 12px; 
                    border-bottom: 1px solid var(--background-modifier-border); 
                    transition: background 0.2s ease;
                    ${folderItem.isSelected ? 'background: rgba(76, 175, 80, 0.1);' : ''}
                ` 
            }
        });
    
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
            attr: { style: 'margin-right: 12px; font-size: 16px; flex-shrink: 0;' }
        });
    
        // 폴더 정보
        const folderInfo = itemEl.createEl('div', { 
            cls: 'folder-info',
            attr: { style: 'flex-grow: 1; min-width: 0;' }
        });
        
        folderInfo.createEl('div', { 
            text: folderItem.name,
            cls: 'folder-name',
            attr: { 
                style: `
                    font-weight: ${folderItem.isSelected ? 'bold' : 'normal'}; 
                    color: ${folderItem.isSelected ? 'var(--color-green)' : 'var(--text-normal)'};
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                ` 
            }
        });
        
        folderInfo.createEl('small', { 
            text: `Path: ${folderItem.path || '/'}`,
            attr: { 
                style: 'color: var(--text-muted); font-size: 0.8em; display: block; margin-top: 2px;' 
            }
        });
    
        // 액션 버튼 컨테이너
        const buttonContainer = itemEl.createEl('div', {
            attr: { style: 'display: flex; gap: 8px; flex-shrink: 0;' }
        });
    
        if (folderItem.isSelected) {
            // 이미 선택된 폴더
            const selectedBtn = buttonContainer.createEl('button', { 
                text: '✅ Selected',
                cls: 'mod-small',
                attr: { 
                    style: 'padding: 4px 8px; font-size: 11px; opacity: 0.7; cursor: not-allowed;',
                    disabled: 'true'
                }
            });
    
            const removeBtn = buttonContainer.createEl('button', { 
                text: '❌ Remove',
                cls: 'mod-small mod-warning',
                attr: { 
                    style: 'padding: 4px 8px; font-size: 11px;' 
                }
            });
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                this.onRemoveFolder(folderItem);
            };
    
        } else {
            // 미선택 폴더
            const selectBtn = buttonContainer.createEl('button', { 
                text: '➕ Select',
                cls: 'mod-small mod-cta',
                attr: { 
                    style: 'padding: 4px 8px; font-size: 11px;' 
                }
            });
            selectBtn.onclick = (e) => {
                e.stopPropagation();
                this.onSelectFolder(folderItem);
            };
    
            // 삭제 버튼 (서버에서 삭제)
            const deleteBtn = buttonContainer.createEl('button', { 
                text: '🗑️',
                cls: 'mod-small mod-warning',
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
            
            new Notice(`✅ Removed folder: ${folderItem.name}`);
            
        } catch (error) {
            console.error('Error removing folder:', error);
            new Notice(`❌ Failed to remove folder: ${folderItem.name}`);
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
            const query = `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,parents)&pageSize=1000`;
            
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.accessToken}`
                },
                throw: false
            });

            if (response.status === 200) {
                const data = response.json;
                
                for (const folder of data.files || []) {
                    const folderPath = basePath ? `${basePath}/${folder.name}` : folder.name;
                    
                    const driveFolder: DriveFolder = {
                        id: folder.id,
                        name: folder.name,
                        path: folderPath,
                        mimeType: folder.mimeType,
                        parents: folder.parents
                    };
                    
                    folders.push(driveFolder);
                    
                    // 하위 폴더도 재귀적으로 로드
                    //const subFolders = await this.getAllDriveFoldersRecursive(folder.id, folderPath);
                    //folders.push(...subFolders);
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
            
            // 폴더 삭제 전 확인
            const confirmDelete = confirm(`Are you sure you want to delete the folder "${folderName}" from Google Drive?\n\nThis action cannot be undone and will move the folder to trash.`);
            
            if (!confirmDelete) {
                console.log('Folder deletion cancelled by user');
                return false;
            }
    
            // Google Drive API를 사용하여 폴더 삭제 (휴지통으로 이동)
            const response = await requestUrl({
                url: `https://www.googleapis.com/drive/v3/files/${folderId}`,
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.accessToken}`
                },
                throw: false
            });
    
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
                    // 폴더 목록 새로고침
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
            const response = await requestUrl({
                url: 'https://www.googleapis.com/drive/v3/files',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [parentId]
                }),
                throw: false
            });

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
    private settingTab: GDriveSyncSettingTab | null = null;

    // 폴더 캐시 초기화 메서드
    private clearFolderCache(): void {
        this.folderCache = {};
        console.log('📁 Folder cache cleared');
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
            this.syncWithGoogleDrive(false);
        });
        ribbonIconEl.addClass('gdrive-sync-ribbon-class');

        // Commands 추가
        this.addCommand({
            id: 'sync-with-gdrive',
            name: 'Sync with Google Drive',
            callback: () => {
                this.syncWithGoogleDrive(false);
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

    onunload() {
        console.log('Unloading plugin...');
        this.stopAutoSync();
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

    // 메인 동기화 메서드
    async syncWithGoogleDrive(showProgress: boolean = true): Promise<SyncResult> {
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
            progressModal.updateStatus('Preparing optimized upload...', 'info');
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
                progressModal.updateStatus('Upload failed', 'error');
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
            progressModal.updateStatus('Preparing download...', 'info');
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
                progressModal.updateStatus('Download failed', 'error');
                setTimeout(() => progressModal?.markCancelled(), 2000);
            } else {
                new Notice(`❌ ${errorMessage}`);
            }
            
            result.errors++;
        }
    
        return result;
    }

    // 양방향 동기화 메서드
    async bidirectionalSync(showProgress: boolean = false): Promise<SyncResult> {
        console.log('Starting bidirectional sync...');
        const result = this.createEmptyResult();
    
        let progressModal: SyncProgressModal | undefined = undefined;
        
        if (showProgress) {
            progressModal = new SyncProgressModal(this.app);
            progressModal.open();
            progressModal.addLog('🔍 Analyzing local and remote files...');
            progressModal.updateStatus('Preparing bidirectional sync...', 'info');
        }
    
        try {
            if (this.settings.syncWholeVault) {
                progressModal?.addLog('📁 Bidirectional mode: Whole Vault');
                
                const rootFolder = await this.getOrCreateDriveFolder();
                if (!rootFolder) {
                    throw new Error('Failed to create or find Google Drive folder');
                }
    
                const localFiles = this.app.vault.getFiles().filter(file => this.shouldSyncFileType(file));
                const driveFiles = await this.getAllFilesFromDrive(rootFolder.id);
    
                progressModal?.addLog(`📱 Local files: ${localFiles.length}`);
                progressModal?.addLog(`☁️ Remote files: ${driveFiles.length}`);
    
                await this.performBidirectionalSync(localFiles, driveFiles, rootFolder.id, result, '', progressModal);
            } else {
                progressModal?.addLog('📂 Bidirectional mode: Selected Folders');
                
                for (const driveFolder of this.settings.selectedDriveFolders) {
                    if (progressModal?.shouldCancel()) {
                        progressModal.markCancelled();
                        return result;
                    }
    
                    progressModal?.addLog(`📁 Processing folder: ${driveFolder.name}`);
                    
                    const localFiles = await this.getLocalFilesForDriveFolder(driveFolder);
                    const driveFiles = await this.getAllFilesFromDrive(driveFolder.id, driveFolder.path);
    
                    progressModal?.addLog(`  📱 Local files: ${localFiles.length}`);
                    progressModal?.addLog(`  ☁️ Remote files: ${driveFiles.length}`);
    
                    await this.performBidirectionalSync(localFiles, driveFiles, driveFolder.id, result, driveFolder.path, progressModal);
                }
            }
    
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();
    
            progressModal?.addLog('🎉 Bidirectional sync completed successfully!');
    
            // 진행 상태가 표시되지 않는 경우 기존 방식으로 결과 표시
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
                progressModal.updateStatus('Bidirectional sync failed', 'error');
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
    private async performBidirectionalSync(
        localFiles: TFile[], 
        driveFiles: any[], 
        rootFolderId: string, 
        result: SyncResult,
        baseFolder: string = '',
        progressModal?: SyncProgressModal
    ): Promise<void> {
        // 파일 매핑 생성
        const localFileMap = new Map<string, TFile>();
        localFiles.forEach(file => {
            let relativePath = file.path;
            
            // baseFolder가 있고 파일 경로가 baseFolder로 시작하는 경우 상대 경로로 변환
            if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                relativePath = file.path.substring(baseFolder.length + 1);
            } else if (baseFolder && file.path === baseFolder) {
                relativePath = '';
            }
            // baseFolder가 없거나 파일 경로가 baseFolder로 시작하지 않는 경우 그대로 사용
            
            localFileMap.set(relativePath, file);
        });
    
        const driveFileMap = new Map<string, any>();
        driveFiles.forEach(file => {
            let relativePath = file.path;
            
            // Google Drive 파일의 경로가 이미 올바르게 설정되어 있으므로
            // baseFolder 처리 시 중복 방지
            if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                relativePath = file.path.substring(baseFolder.length + 1);
            }
            // baseFolder가 없거나 이미 상대 경로인 경우 그대로 사용
            
            driveFileMap.set(relativePath, file);
        });
    
        const allPaths = new Set([...localFileMap.keys(), ...driveFileMap.keys()]);
        const totalFiles = allPaths.size;
        let processedFiles = 0;
    
        progressModal?.addLog(`🔄 Processing ${totalFiles} unique file paths...`);
    
        for (const filePath of allPaths) {
            if (progressModal?.shouldCancel()) {
                return;
            }
    
            const localFile = localFileMap.get(filePath);
            const driveFile = driveFileMap.get(filePath);
    
            try {
                progressModal?.updateProgress(processedFiles, totalFiles, `Processing: ${filePath}`);
    
                if (localFile && driveFile) {
                    // 🔍 충돌 검사 로그를 더 정확하게
                    progressModal?.addLog(`🔍 Checking: ${filePath}`);
                    
                    const initialConflicts = result.conflicts; // 충돌 수 추적
                    await this.resolveFileConflict(localFile, driveFile, rootFolderId, result, baseFolder);
                    
                    // 실제 충돌이 해결된 경우에만 로그 (충돌 수가 증가한 경우)
                    if (result.conflicts > initialConflicts) {
                        progressModal?.addLog(`⚡ Conflict resolved: ${filePath}`);
                    } else {
                        // 충돌이 아니었던 경우
                        progressModal?.addLog(`✅ Already synced: ${filePath}`);
                    }
                } else if (localFile && !driveFile) {
                    progressModal?.addLog(`📤 Upload: ${filePath}`);
                    await this.uploadSingleFile(localFile, rootFolderId, result, baseFolder);
                } else if (!localFile && driveFile) {
                    progressModal?.addLog(`📥 Download: ${filePath}`);
                    await this.downloadFileFromDrive(driveFile, result, baseFolder);
                }
            } catch (error) {
                console.error(`Error syncing file ${filePath}:`, error);
                progressModal?.addLog(`❌ Error processing ${filePath}: ${error.message || 'Unknown error'}`);
                result.errors++;
            }
    
            processedFiles++;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    // Google Drive에서 파일 다운로드
    private async downloadFileFromDrive(driveFile: any, result: SyncResult, baseFolder: string = ''): Promise<void> {
        try {
            let filePath = driveFile.path;
            
            // baseFolder 중복 추가 방지
            if (baseFolder && !filePath.startsWith(baseFolder + '/') && filePath !== baseFolder) {
                filePath = baseFolder + '/' + filePath;
            }
            
            const localFile = this.app.vault.getAbstractFileByPath(filePath);
    
            // 로컬 파일이 있는 경우 수정 시간 비교
            if (localFile instanceof TFile) {
                const needsUpdate = await this.shouldDownloadFile(localFile, driveFile);
                if (!needsUpdate) {
                    return;
                }
            }
    
            // 파일 내용 다운로드
            const content = await this.getFileContentFromDrive(driveFile.id);
    
            // 로컬 폴더 생성 (필요한 경우)
            const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
            if (folderPath && this.settings.createMissingFolders) {
                await this.createLocalFolderStructure(folderPath, result);
            }
    
            // 원격지 수정 시간 가져오기
            const remoteModTime = new Date(driveFile.modifiedTime).getTime();
    
            // 파일 생성 또는 업데이트
            if (localFile instanceof TFile) {
                await this.app.vault.modify(localFile, content);
                console.log(`🔄 ${localFile.name}: Updated`);
            } else {
                await this.app.vault.create(filePath, content);
                console.log(`📥 ${driveFile.name}: Downloaded`);
            }
    
            // 파일 시간 동기화 (중요!)
            await this.syncFileTime(filePath, remoteModTime);
    
        } catch (error) {
            console.error(`❌ ${driveFile.name}: Download failed - ${error.message}`);
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
                const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,size,parents)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
                
                const response = await requestUrl({
                    url: url,
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.settings.accessToken}`
                    },
                    throw: false
                });
    
                if (response.status !== 200) {
                    console.error('Failed to list files:', response.status, response.json);
                    break;
                }
    
                const data = response.json;
                
                for (const file of data.files || []) {
                    // 파일 경로를 올바르게 구성
                    let filePath: string;
                    
                    if (basePath) {
                        // basePath가 있는 경우: basePath/fileName 형태로 구성
                        filePath = `${basePath}/${file.name}`;
                    } else {
                        // basePath가 없는 경우: fileName만 사용
                        filePath = file.name;
                    }
                    
                    if (file.mimeType === 'application/vnd.google-apps.folder') {
                        // 폴더인 경우 재귀적으로 하위 파일들 수집
                        if (this.settings.includeSubfolders) {
                            const subFiles = await this.getAllFilesFromDrive(file.id, filePath);
                            allFiles.push(...subFiles);
                        }
                    } else {
                        // 파일인 경우 경로 정보와 함께 추가
                        allFiles.push({
                            ...file,
                            path: filePath // 이미 완전한 경로
                        });
                        
                        console.log(`Found file: ${file.name}, assigned path: ${filePath}`);
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
        switch (this.settings.syncMode) {
            case 'always':
                return true;
    
            case 'modified':
                const localModTime = localFile.stat.mtime;
                const driveModTime = new Date(driveFile.modifiedTime).getTime();
                
                // 1초 이내 차이는 동일한 것으로 간주
                const timeDiff = Math.abs(localModTime - driveModTime);
                const isNewer = driveModTime > localModTime + 1000; // 1초 버퍼
                
                if (isNewer) {
                    console.log(`📥 ${localFile.name}: Remote newer (${new Date(driveModTime).toLocaleString()} > ${new Date(localModTime).toLocaleString()})`);
                } else {
                    console.log(`⏭️ ${localFile.name}: Skip (times synced)`);
                }
                
                return isNewer;
    
            case 'checksum':
                try {
                    const localContent = await this.app.vault.read(localFile);
                    const localHash = await this.calculateFileHash(localContent);
                    
                    const driveContent = await this.getFileContentFromDrive(driveFile.id);
                    const driveHash = await this.calculateFileHash(driveContent);
                    
                    const isDifferent = localHash !== driveHash;
                    console.log(`${isDifferent ? '📥' : '⏭️'} ${localFile.name}: ${isDifferent ? 'Content differs' : 'Content same'}`);
                    
                    return isDifferent;
                } catch (error) {
                    console.error(`❌ ${localFile.name}: Checksum error - ${error.message}`);
                    return true;
                }
    
            default:
                return true;
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

    shouldSyncFileType(file: TFile): boolean {
        const syncExtensions = ['.md', '.txt', '.json', '.csv', '.html', '.css', '.js'];
        
        const excludePatterns = [
            /^\./, // 숨김 파일
            /\.tmp$/, // 임시 파일
            /\.bak$/, // 백업 파일
            /\.lock$/, // 락 파일
        ];
    
        const hasValidExtension = syncExtensions.some(ext => file.name.endsWith(ext));
        const shouldExclude = excludePatterns.some(pattern => pattern.test(file.name));
    
        return hasValidExtension && !shouldExclude;
    }

    private async shouldSyncFile(localFile: TFile, driveFile: any): Promise<boolean> {
        switch (this.settings.syncMode) {
            case 'always':
                return true;
    
            case 'modified':
                if (!driveFile) {
                    return true;
                }
                
                const localModTime = localFile.stat.mtime;
                const driveModTime = new Date(driveFile.modifiedTime).getTime();
                
                // 1초 이내 차이는 동일한 것으로 간주 (파일시스템 정밀도 고려)
                const timeDiff = Math.abs(localModTime - driveModTime);
                const isNewer = localModTime > driveModTime + 1000; // 1초 버퍼
                
                if (isNewer) {
                    console.log(`📤 ${localFile.name}: Local newer (${new Date(localModTime).toLocaleString()} > ${new Date(driveModTime).toLocaleString()})`);
                } else {
                    console.log(`⏭️ ${localFile.name}: Skip (times synced)`);
                }
                
                return isNewer;
    
            case 'checksum':
                if (!driveFile) {
                    return true;
                }
                
                try {
                    const localContent = await this.app.vault.read(localFile);
                    const localHash = await this.calculateFileHash(localContent);
                    
                    const driveContent = await this.getFileContentFromDrive(driveFile.id);
                    const driveHash = await this.calculateFileHash(driveContent);
                    
                    const isDifferent = localHash !== driveHash;
                    console.log(`${isDifferent ? '📤' : '⏭️'} ${localFile.name}: ${isDifferent ? 'Content differs' : 'Content same'}`);
                    
                    return isDifferent;
                } catch (error) {
                    console.error(`❌ ${localFile.name}: Checksum error - ${error.message}`);
                    return true;
                }
    
            default:
                return true;
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
        let retryCount = 0;
        const maxRetries = 3;
    
        while (retryCount <= maxRetries) {
            try {
                let relativePath = file.path;
                
                // baseFolder 처리 로직...
                if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                    relativePath = file.path.substring(baseFolder.length + 1);
                } else if (baseFolder && file.path === baseFolder) {
                    relativePath = file.name;
                } else if (!baseFolder) {
                    relativePath = file.path;
                }
                
                let fileName = file.name;
                let targetFolderId = rootFolderId;
                
                // 폴더 구조 처리...
                if (relativePath.includes('/')) {
                    const pathParts = relativePath.split('/');
                    fileName = pathParts.pop()!;
                    const folderPath = pathParts.join('/');
                    
                    targetFolderId = await this.getCachedFolderId(folderPath, rootFolderId);
                    if (!targetFolderId) {
                        throw new Error(`Failed to get folder ID for: ${folderPath}`);
                    }
                }
                
                const existingFile = await this.findFileInDrive(fileName, targetFolderId);
                const needsSync = await this.shouldSyncFile(file, existingFile);
                
                if (!needsSync) {
                    console.log(`⏭️ Skipping ${file.path} (no changes detected)`);
                    return 'skipped';
                }
    
                const content = await this.app.vault.read(file);
                const localModTime = file.stat.mtime;
                
                if (existingFile) {
                    console.log(`🔄 Updating ${file.path} in Google Drive`);
                    return await this.updateFileInDrive(existingFile.id, content, localModTime);
                } else {
                    console.log(`📤 Uploading ${file.path} to Google Drive`);
                    return await this.uploadFileToDrive(fileName, content, targetFolderId, localModTime);
                }
    
            } catch (error) {
                if (retryCount >= maxRetries) {
                    console.error(`❌ Failed to sync ${file.path} after ${maxRetries} retries:`, error);
                    return false;
                }
                
                retryCount++;
                console.log(`⚠️ Sync failed for ${file.path}, retrying (${retryCount}/${maxRetries}):`, error.message);
                
                // 재시도 전 잠시 대기
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }
    
        return false;
    }

    private async calculateFileHash(content: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private async getFileContentFromDrive(fileId: string): Promise<string> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                { method: 'GET' }
            );
    
            if (response.status === 200) {
                const decoder = new TextDecoder('utf-8');
                return decoder.decode(response.arrayBuffer);
            } else {
                throw new Error(`Failed to download file: ${response.status}`);
            }
        } catch (error) {
            console.error('Error downloading file from Drive:', error);
            throw error;
        }
    }


    private async findFolderInDrive(folderName: string, parentFolderId: string): Promise<{id: string, name: string} | null> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files?q=name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
                { method: 'GET' }
            );
    
            if (response.status === 200) {
                const data = response.json;
                if (data.files && data.files.length > 0) {
                    return data.files[0];
                }
            }
            return null;
        } catch (error) {
            console.error('Error searching folder in Drive:', error);
            throw error; // 에러를 상위로 전파
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

    private async findFileInDrive(fileName: string, folderId: string): Promise<{id: string, name: string, modifiedTime: string} | null> {
        try {
            const response = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files?q=name='${fileName}' and '${folderId}' in parents and trashed=false&fields=files(id,name,modifiedTime)`,
                { method: 'GET' }
            );
    
            if (response.status === 200) {
                const data = response.json;
                if (data.files && data.files.length > 0) {
                    return data.files[0];
                }
            }
            return null;
        } catch (error) {
            console.error('Error searching file in Drive:', error);
            throw error;
        }
    }

    private async uploadFileToDrive(fileName: string, content: string, folderId: string, localModTime?: number): Promise<boolean> {
        try {
            const metadata = {
                name: fileName,
                parents: [folderId],
                modifiedTime: localModTime ? new Date(localModTime).toISOString() : undefined
            };
    
            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";
    
            let body = delimiter +
                'Content-Type: application/json\r\n\r\n' +
                JSON.stringify(metadata) + delimiter +
                'Content-Type: text/plain\r\n\r\n' +
                content + close_delim;
    
            const response = await this.makeAuthenticatedRequest(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/related; boundary="${boundary}"`
                    },
                    body: body
                }
            );
    
            const success = response.status === 200 || response.status === 201;
            
            if (success && localModTime) {
                console.log(`📤 ${fileName}: Uploaded with time ${new Date(localModTime).toLocaleString()}`);
            } else if (success) {
                console.log(`📤 ${fileName}: Uploaded`);
            }
            
            return success;
        } catch (error) {
            console.error(`❌ ${fileName}: Upload failed - ${error.message}`);
            throw error; // 에러를 상위로 전파하여 재시도 로직에서 처리
        }
    }

    private async updateFileInDrive(fileId: string, content: string, localModTime: number): Promise<boolean> {
        try {
            // 파일 내용 업데이트
            const contentResponse = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'text/plain'
                    },
                    body: content
                }
            );
    
            if (contentResponse.status !== 200) {
                return false;
            }
    
            // 수정 시간 업데이트
            const metadataResponse = await this.makeAuthenticatedRequest(
                `https://www.googleapis.com/drive/v3/files/${fileId}`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        modifiedTime: new Date(localModTime).toISOString()
                    })
                }
            );
    
            const success = metadataResponse.status === 200;
            
            if (success) {
                console.log(`🔄 File updated with time ${new Date(localModTime).toLocaleString()}`);
            }
            
            return success;
        } catch (error) {
            console.error(`❌ Update failed - ${error.message}`);
            throw error;
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
                this.syncWithGoogleDrive(false);
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
    private currentTab: 'auth' | 'sync' | 'advanced' = 'auth';
    private isSetupWizardCollapsed: boolean = true;
    private statusUpdateInterval: number | null = null;

    constructor(app: App, plugin: GDriveSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Add custom CSS
        this.addCustomCSS();

        // Header Section
        this.renderHeader(containerEl);

        // Quick Status Bar
        this.renderQuickStatusBar(containerEl);

        // Setup Wizard (Collapsible)
        this.renderSetupWizard(containerEl);

        // Main Configuration Tabs
        this.renderMainTabs(containerEl);

        // Live Preview Panel
        this.renderLivePreview(containerEl);

        // Start status update interval
        this.startStatusUpdates();
    }

    private addCustomCSS(): void {
        const style = document.createElement('style');
        style.textContent = `
            .gdrive-settings {
                max-width: 900px;
                margin: 0 auto;
                padding: 0 10px; /* 모바일 여백 */
            }
            
            .gdrive-header {
                text-align: center;
                padding: 15px 0; /* 모바일에서 패딩 축소 */
                border-bottom: 2px solid var(--background-modifier-border);
                margin-bottom: 15px;
            }
            
            .gdrive-header h1 {
                font-size: 1.5rem; /* 모바일에서 크기 조정 */
                margin: 0;
            }
            
            .gdrive-quick-status {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px; /* 패딩 축소 */
                background: var(--background-secondary);
                border-radius: 8px;
                margin-bottom: 15px;
                border-left: 4px solid var(--color-green);
                transition: all 0.3s ease;
                flex-wrap: wrap; /* 모바일에서 줄바꿈 허용 */
                gap: 10px;
            }
            
            .gdrive-quick-status.warning {
                border-left-color: var(--color-orange);
            }
            
            .gdrive-quick-status.error {
                border-left-color: var(--color-red);
            }
            
            .status-indicator {
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: bold;
                min-width: 0; /* 텍스트 오버플로우 방지 */
                flex: 1;
            }
            
            .status-dot {
                width: 10px; /* 모바일에서 크기 축소 */
                height: 10px;
                border-radius: 50%;
                background: var(--color-green);
                animation: pulse 2s infinite;
                flex-shrink: 0; /* 크기 고정 */
            }
            
            .status-dot.warning { background: var(--color-orange); }
            .status-dot.error { background: var(--color-red); }
            
            @keyframes pulse {
                0% { opacity: 1; }
                50% { opacity: 0.5; }
                100% { opacity: 1; }
            }
            
            .quick-actions {
                display: flex;
                gap: 8px;
                flex-wrap: wrap; /* 모바일에서 줄바꿈 */
            }
            
            .setup-wizard {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border-radius: 8px;
                padding: 15px; /* 패딩 축소 */
                margin-bottom: 15px;
                transition: max-height 0.3s ease;
                overflow: hidden;
            }
            
            .setup-wizard.collapsed {
                max-height: 50px; /* 높이 축소 */
            }
            
            .setup-wizard:not(.collapsed) {
                max-height: 400px;
            }
            
            .wizard-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: pointer;
            }
            
            .wizard-header h3 {
                font-size: 1.2rem; /* 모바일에서 크기 조정 */
                margin: 0;
            }
            
            .wizard-steps {
                margin-top: 15px;
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); /* 최소 크기 축소 */
                gap: 10px;
            }
            
            .wizard-step {
                background: rgba(255, 255, 255, 0.1);
                padding: 12px; /* 패딩 축소 */
                border-radius: 6px;
                text-align: center;
                transition: transform 0.2s ease;
                font-size: 0.9rem; /* 텍스트 크기 축소 */
            }
            
            .wizard-step:hover {
                transform: translateY(-1px); /* 호버 효과 축소 */
            }
            
            .wizard-step.completed {
                background: rgba(76, 175, 80, 0.3);
            }
            
            .wizard-step.current {
                background: rgba(255, 193, 7, 0.3);
                border: 2px solid rgba(255, 193, 7, 0.8);
            }
            
            .tab-container {
                margin-bottom: 15px;
            }
            
            .tab-nav {
                display: flex;
                background: var(--background-secondary);
                border-radius: 8px 8px 0 0;
                overflow: hidden;
                overflow-x: auto; /* 모바일에서 스크롤 허용 */
            }
            
            .tab-button {
                flex: 1;
                min-width: 120px; /* 최소 너비 설정 */
                padding: 12px 15px; /* 패딩 축소 */
                background: transparent;
                border: none;
                cursor: pointer;
                transition: background 0.3s ease;
                font-weight: 500;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                font-size: 0.9rem; /* 텍스트 크기 축소 */
                white-space: nowrap; /* 텍스트 줄바꿈 방지 */
            }
            
            .tab-button:hover {
                background: var(--background-modifier-hover);
            }
            
            .tab-button.active {
                background: var(--background-primary);
                color: var(--text-accent);
                border-bottom: 3px solid var(--text-accent);
            }
            
            .tab-content {
                background: var(--background-primary);
                border-radius: 0 0 8px 8px;
                padding: 15px; /* 패딩 축소 */
                border: 1px solid var(--background-modifier-border);
                border-top: none;
                min-height: 300px; /* 높이 축소 */
            }
            
            .live-preview {
                background: var(--background-secondary);
                border-radius: 8px;
                padding: 15px; /* 패딩 축소 */
                margin-top: 15px;
            }
            
            .sync-overview {
                display: grid;
                grid-template-columns: 1fr auto 1fr;
                gap: 15px; /* 간격 축소 */
                align-items: center;
                margin-bottom: 15px;
            }
            
            /* 모바일에서 세로 레이아웃으로 변경 */
            @media (max-width: 768px) {
                .gdrive-settings {
                    padding: 0 5px;
                }
                
                .gdrive-quick-status {
                    flex-direction: column;
                    align-items: stretch;
                    text-align: center;
                    gap: 10px;
                }
                
                .quick-actions {
                    justify-content: center;
                    width: 100%;
                }
                
                .sync-overview {
                    grid-template-columns: 1fr;
                    grid-template-rows: auto auto auto;
                    gap: 10px;
                    text-align: center;
                }
                
                .wizard-steps {
                    grid-template-columns: 1fr;
                }
                
                .tab-nav {
                    flex-direction: column;
                }
                
                .tab-button {
                    min-width: unset;
                    width: 100%;
                }
                
                .folder-browser {
                    max-height: 200px; /* 모바일에서 높이 축소 */
                }
                
                .action-button {
                    width: 100%; /* 모바일에서 전체 너비 */
                    justify-content: center;
                    margin-bottom: 8px;
                }
                
                .setting-group {
                    padding: 12px;
                    margin-bottom: 15px;
                }
            }
            
            /* 작은 모바일 화면 */
            @media (max-width: 480px) {
                .gdrive-header h1 {
                    font-size: 1.3rem;
                }
                
                .tab-content {
                    padding: 10px;
                }
                
                .live-preview {
                    padding: 10px;
                }
                
                .wizard-step {
                    padding: 8px;
                    font-size: 0.8rem;
                }
                
                .action-button {
                    padding: 10px 15px;
                    font-size: 14px;
                }
            }
            
            .file-count-box {
                text-align: center;
                padding: 15px; /* 패딩 축소 */
                background: var(--background-primary);
                border-radius: 6px;
                border: 2px solid var(--background-modifier-border);
            }
            
            .sync-action-box {
                text-align: center;
                padding: 12px; /* 패딩 축소 */
                background: linear-gradient(135deg, #4CAF50, #45a049);
                color: white;
                border-radius: 6px;
                font-weight: bold;
            }
            
            .connection-status {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px; /* 패딩 축소 */
                background: var(--background-secondary);
                border-radius: 6px;
                margin-bottom: 15px;
                flex-wrap: wrap; /* 모바일 줄바꿈 */
            }
            
            .connection-status.connected {
                border-left: 4px solid var(--color-green);
            }
            
            .connection-status.warning {
                border-left: 4px solid var(--color-orange);
            }
            
            .connection-status.error {
                border-left: 4px solid var(--color-red);
            }
            
            .folder-browser {
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                max-height: 250px; /* 높이 축소 */
                overflow-y: auto;
            }
            
            .folder-item {
                display: flex;
                align-items: center;
                padding: 8px 12px; /* 패딩 축소 */
                border-bottom: 1px solid var(--background-modifier-border);
                transition: background 0.2s ease;
                flex-wrap: wrap; /* 모바일 줄바꿈 */
                gap: 8px;
            }
            
            .folder-item:hover {
                background: var(--background-modifier-hover);
            }
            
            .folder-icon {
                margin-right: 8px; /* 간격 축소 */
                font-size: 14px;
                flex-shrink: 0;
            }
            
            .folder-info {
                flex-grow: 1;
                min-width: 0; /* 텍스트 오버플로우 방지 */
            }
            
            .folder-info div {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            
            .folder-actions {
                display: flex;
                gap: 4px;
                flex-shrink: 0;
            }
            
            .btn-small {
                padding: 3px 6px; /* 크기 축소 */
                font-size: 10px;
                border-radius: 3px;
            }
            
            .progress-bar {
                width: 100%;
                height: 4px; /* 높이 축소 */
                background: var(--background-modifier-border);
                border-radius: 2px;
                overflow: hidden;
                margin: 8px 0; /* 여백 축소 */
            }
            
            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #4CAF50, #45a049);
                transition: width 0.3s ease;
                border-radius: 2px;
            }
            
            .setting-group {
                margin-bottom: 20px; /* 여백 축소 */
                padding: 15px; /* 패딩 축소 */
                background: var(--background-secondary);
                border-radius: 6px;
                border-left: 4px solid var(--text-accent);
            }
            
            .setting-group h4 {
                margin: 0 0 12px 0; /* 여백 축소 */
                color: var(--text-accent);
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 1.1rem; /* 크기 조정 */
            }
            
            .credentials-toggle {
                cursor: pointer;
                user-select: none;
                transition: all 0.2s ease;
            }
            
            .credentials-toggle:hover {
                color: var(--text-accent);
            }
            
            .smart-suggestions {
                background: linear-gradient(135deg, #e3f2fd, #bbdefb);
                border-radius: 6px;
                padding: 12px; /* 패딩 축소 */
                margin-top: 12px;
                border-left: 4px solid #2196F3;
            }
            
            .sync-interval-value {
                font-weight: bold;
                color: var(--text-accent);
                margin-left: 8px; /* 간격 축소 */
                min-width: 70px; /* 너비 축소 */
                text-align: right;
                display: inline-block;
            }
            
            .setting-item .slider {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap; /* 모바일 줄바꿈 */
            }
            
            .setting-item .slider input[type="range"] {
                flex-grow: 1;
                min-width: 120px; /* 최소 너비 */
            }
            
            .tooltip {
                position: relative;
                cursor: help;
            }
            
            .tooltip:hover::after {
                content: attr(data-tooltip);
                position: absolute;
                bottom: 100%;
                left: 50%;
                transform: translateX(-50%);
                background: var(--background-primary);
                color: var(--text-normal);
                padding: 6px 10px; /* 크기 축소 */
                border-radius: 4px;
                font-size: 11px; /* 폰트 크기 축소 */
                white-space: nowrap;
                z-index: 1000;
                border: 1px solid var(--background-modifier-border);
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            }
            
            .action-button {
                display: inline-flex;
                align-items: center;
                gap: 6px; /* 간격 축소 */
                padding: 8px 16px; /* 패딩 축소 */
                border-radius: 5px;
                font-weight: 500;
                transition: all 0.2s ease;
                text-decoration: none;
                border: none;
                cursor: pointer;
                font-size: 0.9rem; /* 폰트 크기 축소 */
            }
            
            .action-button.primary {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
            }
            
            .action-button.secondary {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .action-button.warning {
                background: var(--color-orange);
                color: white;
            }
            
            .action-button:hover {
                transform: translateY(-1px);
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            }
            
            /* 터치 디바이스에서 호버 효과 비활성화 */
            @media (hover: none) and (pointer: coarse) {
                .action-button:hover,
                .wizard-step:hover,
                .folder-item:hover {
                    transform: none;
                    background: var(--background-modifier-hover);
                }
            }

            .sync-actions-container {
                margin-top: 25px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .sync-primary-button {
                width: 100%;
                padding: 15px 20px;
                font-size: 16px;
                font-weight: bold;
                border-radius: 8px;
                transition: all 0.2s ease;
            }

            .sync-primary-button:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            }

            .sync-secondary-actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
            }

            .sync-secondary-button {
                padding: 10px 16px;
                font-size: 14px;
                border-radius: 6px;
                text-align: center;
                transition: all 0.2s ease;
            }

            .sync-secondary-button:hover {
                transform: translateY(-1px);
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }

            /* 모바일 대응 */
            @media (max-width: 480px) {
                .sync-secondary-actions {
                    grid-template-columns: 1fr;
                    gap: 8px;
                }
                
                .sync-primary-button {
                    padding: 12px 16px;
                    font-size: 15px;
                }
                
                .sync-secondary-button {
                    padding: 8px 12px;
                    font-size: 13px;
                }
            }

            /* Authorization Code 섹션 개선 */
            #auth-code-section input {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                font-size: 14px;
                transition: border-color 0.2s ease;
            }

            #auth-code-section input:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }

            #auth-code-section button:disabled {
                opacity: 0.6;
                cursor: not-allowed;
                transform: none !important;
            }

            .folder-list-container {
                background: var(--background-primary);
            }

            .folder-list-item {
                border-radius: 6px;
                margin-bottom: 4px;
            }

            .folder-list-item.selected {
                border-left: 4px solid var(--color-green);
            }

            .folder-list-item.available {
                border-left: 4px solid transparent;
            }

            .folder-list-item:last-child {
                border-bottom: none;
                margin-bottom: 0;
            }

            .folder-info {
                line-height: 1.4;
            }

            .folder-name {
                font-size: 14px;
            }

            /* 모바일 대응 */
            @media (max-width: 768px) {
                .folder-list-item {
                    flex-direction: column;
                    align-items: stretch;
                    gap: 8px;
                }
                
                .folder-info {
                    text-align: center;
                }
                
                .folder-list-item div[style*="display: flex"] {
                    justify-content: center;
                    width: 100%;
                }
            }                        
        `;
        document.head.appendChild(style);
    }

    private renderHeader(container: HTMLElement): void {
        const header = container.createEl('div', { cls: 'gdrive-header' });
        header.createEl('h1', { 
            text: '☁️ Google Drive Sync',
            attr: { style: 'margin: 0; color: var(--text-accent);' }
        });
        header.createEl('p', { 
            text: 'Seamlessly sync your Obsidian vault with Google Drive',
            attr: { style: 'margin: 10px 0 0 0; color: var(--text-muted);' }
        });
    }

    private renderQuickStatusBar(container: HTMLElement): void {
        const statusBar = container.createEl('div', { cls: 'gdrive-quick-status' });
        
        const statusIndicator = statusBar.createEl('div', { cls: 'status-indicator' });
        const statusDot = statusIndicator.createEl('div', { cls: 'status-dot' });
        const statusText = statusIndicator.createEl('span', { text: 'Checking connection...' });
        
        const quickActions = statusBar.createEl('div', { cls: 'quick-actions' });
        
        const syncButton = quickActions.createEl('button', { 
            cls: 'action-button primary',
            text: '🔄 Sync Now'
        });
        syncButton.onclick = () => this.plugin.syncWithGoogleDrive(true);
        
        const settingsButton = quickActions.createEl('button', { 
            cls: 'action-button secondary',
            text: '⚙️ Quick Setup'
        });
        settingsButton.onclick = () => this.toggleSetupWizard();
        
        // Store references for updates
        statusBar.dataset.statusDot = 'status-dot';
        statusBar.dataset.statusText = 'status-text';
        
        this.updateQuickStatus(statusBar);
    }

    private updateQuickStatus(statusBar: HTMLElement): void {
        const statusDot = statusBar.querySelector('.status-dot') as HTMLElement;
        const statusText = statusBar.querySelector('.status-indicator span') as HTMLElement;
        
        const isAuth = this.plugin.isAuthenticated();
        const hasRefreshToken = !!this.plugin.settings.refreshToken;
        const tokenExpiresAt = this.plugin.settings.tokenExpiresAt;
        
        if (isAuth && hasRefreshToken) {
            if (tokenExpiresAt > 0) {
                const now = Date.now();
                const minutesUntilExpiry = Math.round((tokenExpiresAt - now) / (1000 * 60));
                
                if (now >= tokenExpiresAt) {
                    statusBar.className = 'gdrive-quick-status warning';
                    statusDot.className = 'status-dot warning';
                    statusText.textContent = '🔄 Token expired - will refresh automatically';
                } else if (minutesUntilExpiry < 10) {
                    statusBar.className = 'gdrive-quick-status warning';
                    statusDot.className = 'status-dot warning';
                    statusText.textContent = `⏰ Token expires in ${minutesUntilExpiry} minutes`;
                } else {
                    statusBar.className = 'gdrive-quick-status';
                    statusDot.className = 'status-dot';
                    statusText.textContent = `✅ Connected - expires ${new Date(tokenExpiresAt).toLocaleTimeString()}`;
                }
            } else {
                statusBar.className = 'gdrive-quick-status';
                statusDot.className = 'status-dot';
                statusText.textContent = '✅ Connected with long-term authentication';
            }
        } else {
            statusBar.className = 'gdrive-quick-status error';
            statusDot.className = 'status-dot error';
            statusText.textContent = '❌ Not authenticated - please sign in';
        }
    }

    private renderSetupWizard(container: HTMLElement): void {
        const wizard = container.createEl('div', { 
            cls: `setup-wizard ${this.isSetupWizardCollapsed ? 'collapsed' : ''}`
        });
        
        const wizardHeader = wizard.createEl('div', { cls: 'wizard-header' });
        wizardHeader.onclick = () => this.toggleSetupWizard();
        
        wizardHeader.createEl('h3', { 
            text: '🎯 Quick Start Guide',
            attr: { style: 'margin: 0; flex-grow: 1;' }
        });
        
        const toggleIcon = wizardHeader.createEl('span', { 
            text: this.isSetupWizardCollapsed ? '▼' : '▲',
            attr: { style: 'font-size: 12px; transition: transform 0.3s ease;' }
        });
        
        if (!this.isSetupWizardCollapsed) {
            const wizardSteps = wizard.createEl('div', { cls: 'wizard-steps' });
            
            const steps = [
                { 
                    title: 'Google Cloud Setup', 
                    desc: 'Configure API credentials',
                    completed: !!(this.plugin.settings.clientId && this.plugin.settings.clientSecret && this.plugin.settings.apiKey)
                },
                { 
                    title: 'Authenticate', 
                    desc: 'Sign in to Google Drive',
                    completed: this.plugin.isAuthenticated()
                },
                { 
                    title: 'Choose Sync Mode', 
                    desc: 'Select folders to sync',
                    completed: this.plugin.settings.syncWholeVault || this.plugin.settings.selectedDriveFolders.length > 0
                },
                { 
                    title: 'First Sync', 
                    desc: 'Start synchronization',
                    completed: this.plugin.settings.lastSyncTime > 0
                }
            ];
            
            steps.forEach((step, index) => {
                const stepEl = wizardSteps.createEl('div', { 
                    cls: `wizard-step ${step.completed ? 'completed' : ''} ${this.getCurrentStepIndex() === index ? 'current' : ''}`
                });
                
                stepEl.createEl('div', { 
                    text: `${index + 1}. ${step.title}`,
                    attr: { style: 'font-weight: bold; margin-bottom: 5px;' }
                });
                
                stepEl.createEl('div', { 
                    text: step.desc,
                    attr: { style: 'font-size: 12px; opacity: 0.9;' }
                });
                
                if (step.completed) {
                    stepEl.createEl('div', { 
                        text: '✅',
                        attr: { style: 'font-size: 18px; margin-top: 8px;' }
                    });
                }
            });
        }
    }

    private getCurrentStepIndex(): number {
        if (!(this.plugin.settings.clientId && this.plugin.settings.clientSecret && this.plugin.settings.apiKey)) return 0;
        if (!this.plugin.isAuthenticated()) return 1;
        if (!(this.plugin.settings.syncWholeVault || this.plugin.settings.selectedDriveFolders.length > 0)) return 2;
        if (this.plugin.settings.lastSyncTime === 0) return 3;
        return -1; // All completed
    }

    private toggleSetupWizard(): void {
        this.isSetupWizardCollapsed = !this.isSetupWizardCollapsed;
        this.display(); // Re-render
    }

    private renderMainTabs(container: HTMLElement): void {
        const tabContainer = container.createEl('div', { cls: 'tab-container' });
        
        // Tab Navigation
        const tabNav = tabContainer.createEl('div', { cls: 'tab-nav' });
        
        const tabs = [
            { id: 'auth', label: '🔐 Authentication', icon: '🔐' },
            { id: 'sync', label: '📂 Sync Configuration', icon: '📂' },
            { id: 'advanced', label: '⚙️ Advanced', icon: '⚙️' }
        ];
        
        tabs.forEach(tab => {
            const tabButton = tabNav.createEl('button', { 
                cls: `tab-button ${this.currentTab === tab.id ? 'active' : ''}`,
                text: tab.label
            });
            
            tabButton.onclick = () => {
                this.currentTab = tab.id as any;
                this.display();
            };
        });
        
        // Tab Content
        const tabContent = tabContainer.createEl('div', { cls: 'tab-content' });
        
        switch (this.currentTab) {
            case 'auth':
                this.renderAuthTab(tabContent);
                break;
            case 'sync':
                this.renderSyncTab(tabContent);
                break;
            case 'advanced':
                this.renderAdvancedTab(tabContent);
                break;
        }
    }

    private renderAuthTab(container: HTMLElement): void {
        // Connection Status
        this.renderConnectionStatus(container);
        
        // Credentials Section
        const credentialsGroup = container.createEl('div', { cls: 'setting-group' });
        credentialsGroup.createEl('h4', { text: '🔑 API Credentials' });
        
        new Setting(credentialsGroup)
            .setName('Client ID')
            .setDesc('Google Cloud Console OAuth 2.0 Client ID')
            .addText(text => text
                .setPlaceholder('Enter your Client ID')
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(credentialsGroup)
            .setName('Client Secret')
            .setDesc('Google Cloud Console OAuth 2.0 Client Secret')
            .addText(text => text
                .setPlaceholder('Enter your Client Secret')
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(credentialsGroup)
            .setName('API Key')
            .setDesc('Google Cloud Console API Key for Google Drive API')
            .addText(text => text
                .setPlaceholder('Enter your API Key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));
        
        // Authentication Actions
        const actionsGroup = container.createEl('div', { cls: 'setting-group' });
        actionsGroup.createEl('h4', { text: '🚀 Authentication Actions' });
        
        const actionsContainer = actionsGroup.createEl('div', { 
            attr: { style: 'display: flex; gap: 10px; flex-wrap: wrap;' }
        });
        
        const authenticateBtn = actionsContainer.createEl('button', { 
            cls: 'action-button primary',
            text: '🔗 Authenticate'
        });
        authenticateBtn.onclick = () => this.plugin.authenticateGoogleDrive();
        
        const testBtn = actionsContainer.createEl('button', { 
            cls: 'action-button secondary',
            text: '🧪 Test Connection'
        });
        testBtn.onclick = () => this.plugin.testDriveAPIConnection();
        
        const refreshBtn = actionsContainer.createEl('button', { 
            cls: 'action-button secondary',
            text: '🔄 Refresh Token'
        });
        refreshBtn.onclick = async () => {
            const success = await this.plugin.refreshAccessToken();
            if (success) {
                new Notice('✅ Token refreshed successfully');
                this.display();
            }
        };
        
        const signOutBtn = actionsContainer.createEl('button', { 
            cls: 'action-button warning',
            text: '🚪 Sign Out'
        });
        signOutBtn.onclick = async () => {
            await this.plugin.revokeGoogleDriveAccess();
        };
        this.renderAuthCodeSection(container);
    }
    private renderAuthCodeSection(container: HTMLElement): void {
        // 기존 Authorization Code 섹션이 있으면 제거
        const existingAuthCode = container.querySelector('#auth-code-section');
        if (existingAuthCode) {
            existingAuthCode.remove();
        }
        
        const authCodeGroup = container.createEl('div', { 
            cls: 'setting-group',
            attr: { 
                id: 'auth-code-section',
                style: this.plugin.isAuthenticated() ? 'display: none;' : 'display: block;'
            }
        });
        authCodeGroup.createEl('h4', { text: '🔐 Authorization Code' });
        
        // 입력 필드와 버튼을 별도 컨테이너로 분리
        const inputContainer = authCodeGroup.createEl('div', {
            attr: { style: 'margin-bottom: 15px;' }
        });
        
        const inputLabel = inputContainer.createEl('label', { 
            text: 'Paste Authorization Code',
            attr: { style: 'display: block; margin-bottom: 8px; font-weight: bold;' }
        });
        
        const inputDesc = inputContainer.createEl('div', { 
            text: 'After clicking "Authenticate", paste the code here',
            attr: { style: 'font-size: 0.9em; color: var(--text-muted); margin-bottom: 10px;' }
        });
        
        const authInput = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'Paste authorization code...',
            attr: { 
                style: 'width: 100%; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 4px; margin-bottom: 15px;'
            }
        });
        
        // 버튼 컨테이너
        const buttonContainer = authCodeGroup.createEl('div', {
            attr: { 
                style: 'display: flex; justify-content: flex-end; gap: 10px;'
            }
        });
        
        const exchangeButton = buttonContainer.createEl('button', {
            cls: 'action-button primary',
            text: 'Exchange for Token',
            attr: { 
                style: 'padding: 10px 20px; font-weight: bold;'
            }
        });
        
        // Enter 키 이벤트 핸들러
        authInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                exchangeButton.click();
            }
        });
        
        exchangeButton.onclick = async () => {
            const authCode = authInput.value?.trim();
            
            if (!authCode) {
                new Notice('❌ Please enter authorization code first');
                authInput.focus();
                return;
            }
            
            // 버튼 비활성화 및 로딩 표시
            exchangeButton.disabled = true;
            exchangeButton.textContent = 'Exchanging...';
            
            try {
                const success = await this.plugin.exchangeCodeForToken(authCode);
                if (success) {
                    authInput.value = '';
                    this.display();
                }
            } finally {
                // 버튼 복원
                exchangeButton.disabled = false;
                exchangeButton.textContent = 'Exchange for Token';
            }
        };
    }

    private renderConnectionStatus(container: HTMLElement): void {
        const statusGroup = container.createEl('div', { cls: 'setting-group' });
        statusGroup.createEl('h4', { text: '📊 Connection Status' });
        
        const status = statusGroup.createEl('div', { cls: 'connection-status' });
        
        const isAuth = this.plugin.isAuthenticated();
        const hasRefreshToken = !!this.plugin.settings.refreshToken;
        
        // Connection status classes
        if (isAuth && hasRefreshToken) {
            status.classList.add('connected');
            const statusContent = document.createElement('div');
            statusContent.style.flexGrow = '1';
            statusContent.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 5px;">✅ Connected</div>
                <div style="font-size: 12px; opacity: 0.8;">
                    ${this.plugin.settings.tokenExpiresAt > 0 ? 
                        `Token expires: ${new Date(this.plugin.settings.tokenExpiresAt).toLocaleString()}` : 
                        'Long-term authentication active'}
                </div>
            `;
            status.appendChild(statusContent);
        } else {
            status.classList.add('error');
            const statusContent = document.createElement('div');
            statusContent.style.flexGrow = '1';
            statusContent.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 5px;">❌ Not Connected</div>
                <div style="font-size: 12px; opacity: 0.8;">Please authenticate to start syncing</div>
            `;
            status.appendChild(statusContent);
        }
    }

    private renderSyncTab(container: HTMLElement): void {
        // Sync Mode Selection
        const modeGroup = container.createEl('div', { cls: 'setting-group' });
        modeGroup.createEl('h4', { text: '📁 Sync Mode' });
        
        new Setting(modeGroup)
            .setName('Sync Whole Vault')
            .setDesc('Sync your entire vault with Google Drive root folder')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncWholeVault)
                .onChange(async (value) => {
                    this.plugin.settings.syncWholeVault = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));
        
        // Folder Selection (only if not syncing whole vault)
        if (!this.plugin.settings.syncWholeVault) {
            this.renderFolderSelection(container);
        }
        
        // Sync Rules
        this.renderSyncRules(container);
    }

    private renderFolderSelection(container: HTMLElement): void {
        const folderGroup = container.createEl('div', { cls: 'setting-group' });
        folderGroup.createEl('h4', { text: '📂 Google Drive Folders' });
        
        // Browse Google Drive Button
        const browseContainer = folderGroup.createEl('div', { 
            attr: { style: 'margin-bottom: 15px;' }
        });
        
        const browseBtn = browseContainer.createEl('button', { 
            cls: 'action-button primary',
            text: '📁 Browse Google Drive'
        });
        browseBtn.onclick = () => this.openDriveFolderSelector();
        
        // Selected Folders Display
        if (this.plugin.settings.selectedDriveFolders.length > 0) {
            const folderList = folderGroup.createEl('div', { cls: 'folder-browser' });
            
            this.plugin.settings.selectedDriveFolders.forEach((folder, index) => {
                const folderItem = folderList.createEl('div', { cls: 'folder-item' });
                
                folderItem.createEl('span', { 
                    cls: 'folder-icon',
                    text: '☁️'
                });
                
                const folderInfo = folderItem.createEl('div', { cls: 'folder-info' });
                folderInfo.createEl('div', { 
                    text: folder.name,
                    attr: { style: 'font-weight: bold;' }
                });
                folderInfo.createEl('small', { 
                    text: `Path: ${folder.path || '/'}`,
                    attr: { style: 'color: var(--text-muted);' }
                });
                
                const folderActions = folderItem.createEl('div', { cls: 'folder-actions' });
                
                const removeBtn = folderActions.createEl('button', { 
                    cls: 'btn-small action-button warning',
                    text: '✖'
                });
                removeBtn.onclick = async () => {
                    this.plugin.settings.selectedDriveFolders.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                    new Notice(`Removed: ${folder.name}`);
                };
            });
        } else {
            const emptyState = folderGroup.createEl('div', { 
                attr: { 
                    style: 'text-align: center; padding: 30px; color: var(--text-muted); border: 2px dashed var(--background-modifier-border); border-radius: 8px;'
                }
            });
            emptyState.createEl('div', { 
                text: '📂',
                attr: { style: 'font-size: 48px; margin-bottom: 10px;' }
            });
            emptyState.createEl('div', { text: 'No folders selected yet' });
            emptyState.createEl('small', { 
                text: 'Click "Browse Google Drive" to select folders for sync',
                attr: { style: 'display: block; margin-top: 5px;' }
            });
        }
        
        // Smart Suggestions
        if (this.plugin.settings.selectedDriveFolders.length > 0) {
            const suggestions = folderGroup.createEl('div', { cls: 'smart-suggestions' });
            suggestions.createEl('strong', { text: '💡 Smart Suggestions:' });
            const suggestionsList = suggestions.createEl('ul');
            suggestionsList.innerHTML = `
                <li>Selected folders will sync with local folders of the same name</li>
                <li>Subfolders are included automatically if enabled in Advanced settings</li>
                <li>Only .md, .txt, and other supported file types will be synced</li>
            `;
        }
    }

    private renderSyncRules(container: HTMLElement): void {
        const rulesGroup = container.createEl('div', { cls: 'setting-group' });
        rulesGroup.createEl('h4', { text: '🔄 Sync Rules' });
        
        new Setting(rulesGroup)
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

        new Setting(rulesGroup)
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

        new Setting(rulesGroup)
            .setName('Include Subfolders')
            .setDesc('Recursively sync files from subfolders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeSubfolders)
                .onChange(async (value) => {
                    this.plugin.settings.includeSubfolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(rulesGroup)
            .setName('Create Missing Folders')
            .setDesc('Automatically create local folders when downloading from Google Drive')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createMissingFolders)
                .onChange(async (value) => {
                    this.plugin.settings.createMissingFolders = value;
                    await this.plugin.saveSettings();
                }));
    }

    private renderAdvancedTab(container: HTMLElement): void {
        // Performance Settings
        const performanceGroup = container.createEl('div', { cls: 'setting-group' });
        performanceGroup.createEl('h4', { text: '⚡ Performance' });
        
        new Setting(performanceGroup)
            .setName('Sync Mode')
            .setDesc('How to determine if files need to be synced')
            .addDropdown(dropdown => dropdown
                .addOption('always', 'Always sync (force upload)')
                .addOption('modified', 'Modified time comparison (recommended)')
                .addOption('checksum', 'Content checksum comparison (most accurate)')
                .setValue(this.plugin.settings.syncMode)
                .onChange(async (value: 'always' | 'modified' | 'checksum') => {
                    this.plugin.settings.syncMode = value;
                    await this.plugin.saveSettings();
                }));

                new Setting(performanceGroup)
                .setName('Auto Sync')
                .setDesc('Automatically sync at regular intervals')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.autoSync)
                    .onChange(async (value) => {
                        console.log(`Auto sync toggle changed to: ${value}`);
                        
                        this.plugin.settings.autoSync = value;
                        await this.plugin.saveSettings();
                        
                        if (value) {
                            console.log('Auto sync enabled - setting up interval...');
                            this.plugin.setupAutoSync();
                            new Notice('✅ Auto sync enabled');
                        } else {
                            console.log('Auto sync disabled - stopping interval...');
                            this.plugin.stopAutoSync();
                            new Notice('❌ Auto sync disabled');
                        }
                        
                        // UI 업데이트
                        setTimeout(() => this.updateAutoSyncStatus(), 100);
                    }))
                .then(setting => {
                    // Auto Sync 상태 표시 추가
                    const statusEl = setting.descEl.createEl('div', {
                        cls: 'auto-sync-status',
                        attr: { style: 'margin-top: 8px; font-size: 12px;' }
                    });
                    this.updateAutoSyncStatus(statusEl);
                });

                new Setting(performanceGroup)
                .setName('Sync Interval')
                .setDesc('How often to sync (in minutes)')
                .addSlider(slider => {
                    const currentValue = this.plugin.settings.syncInterval / 60000;
                    return slider
                        .setLimits(1, 60, 1)
                        .setValue(currentValue)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            console.log(`Sync interval changed to: ${value} minutes`);
                            
                            this.plugin.settings.syncInterval = value * 60000;
                            await this.plugin.saveSettings();
                            
                            // Update the display text
                            const sliderContainer = slider.sliderEl.parentElement;
                            if (sliderContainer) {
                                let valueDisplay = sliderContainer.querySelector('.sync-interval-value') as HTMLElement;
                                if (!valueDisplay) {
                                    valueDisplay = sliderContainer.createEl('span', { 
                                        cls: 'sync-interval-value',
                                        attr: { style: 'margin-left: 10px; font-weight: bold; color: var(--text-accent);' }
                                    });
                                }
                                valueDisplay.textContent = `${value} minute${value !== 1 ? 's' : ''}`;
                            }
                            
                            // Auto Sync가 활성화되어 있으면 새 간격으로 재설정
                            if (this.plugin.settings.autoSync) {
                                console.log('Restarting auto sync with new interval...');
                                this.plugin.setupAutoSync();
                                new Notice(`Auto sync interval updated to ${value} minute${value !== 1 ? 's' : ''}`);
                            }
                            
                            // UI 상태 업데이트
                            setTimeout(() => this.updateAutoSyncStatus(), 100);
                        });
                })
                .then(setting => {
                    // Add initial value display
                    const sliderContainer = setting.controlEl.querySelector('.slider') as HTMLElement;
                    if (sliderContainer) {
                        const currentValue = this.plugin.settings.syncInterval / 60000;
                        const valueDisplay = sliderContainer.createEl('span', { 
                            cls: 'sync-interval-value',
                            text: `${currentValue} minute${currentValue !== 1 ? 's' : ''}`,
                            attr: { style: 'margin-left: 10px; font-weight: bold; color: var(--text-accent);' }
                        });
                    }
                });

        // Google Drive Settings
        const driveGroup = container.createEl('div', { cls: 'setting-group' });
        driveGroup.createEl('h4', { text: '☁️ Google Drive Settings' });
        
        new Setting(driveGroup)
            .setName('Root Folder Name')
            .setDesc('Name of the root folder in Google Drive')
            .addText(text => text
                .setPlaceholder('e.g., Obsidian-Sync')
                .setValue(this.plugin.settings.driveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.driveFolder = value;
                    await this.plugin.saveSettings();
                }));

        // Troubleshooting
        const troubleshootGroup = container.createEl('div', { cls: 'setting-group' });
        troubleshootGroup.createEl('h4', { text: '🔧 Troubleshooting' });
        
        const troubleshootActions = troubleshootGroup.createEl('div', { 
            attr: { style: 'display: flex; gap: 10px; flex-wrap: wrap;' }
        });
        
        const clearCacheBtn = troubleshootActions.createEl('button', { 
            cls: 'action-button secondary',
            text: '🧹 Clear Cache'
        });
        clearCacheBtn.onclick = () => {
            // Clear folder cache - using proper type assertion
            (this.plugin as any).folderCache = {};
            new Notice('✅ Cache cleared successfully');
        };
        
        const exportLogsBtn = troubleshootActions.createEl('button', { 
            cls: 'action-button secondary',
            text: '📋 Export Logs'
        });
        exportLogsBtn.onclick = () => {
            const logs = {
                settings: this.plugin.settings,
                isAuthenticated: this.plugin.isAuthenticated(),
                timestamp: new Date().toISOString()
            };
            navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
            new Notice('📋 Settings exported to clipboard');
        };
        
        // Add the DEFAULT_SETTINGS constant reference
        const DEFAULT_SETTINGS = {
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
            syncMode: 'modified' as const,
            lastSyncTime: 0,
            syncDirection: 'bidirectional' as const,
            conflictResolution: 'newer' as const,
            createMissingFolders: true,
            selectedDriveFolders: []
        };
        
        const resetBtn = troubleshootActions.createEl('button', { 
            cls: 'action-button warning',
            text: '🔄 Reset Settings'
        });
        resetBtn.onclick = async () => {
            if (confirm('Are you sure you want to reset all settings? This cannot be undone.')) {
                this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                await this.plugin.saveSettings();
                this.display();
                new Notice('⚠️ Settings reset to defaults');
            }
        };
        
        // Debug Information
        const debugGroup = container.createEl('div', { cls: 'setting-group' });
        debugGroup.createEl('h4', { text: '🐛 Debug Information' });
        
        const debugInfo = debugGroup.createEl('div', { 
            attr: { 
                style: 'background: var(--background-primary); padding: 15px; border-radius: 6px; font-family: monospace; font-size: 11px; max-height: 200px; overflow-y: auto;'
            }
        });
        
        const debugData = {
            version: '1.0.0',
            authenticated: this.plugin.isAuthenticated(),
            hasRefreshToken: !!this.plugin.settings.refreshToken,
            tokenExpires: this.plugin.settings.tokenExpiresAt > 0 ? new Date(this.plugin.settings.tokenExpiresAt).toLocaleString() : 'Unknown',
            selectedFolders: this.plugin.settings.selectedDriveFolders.length,
            lastSync: this.plugin.settings.lastSyncTime > 0 ? new Date(this.plugin.settings.lastSyncTime).toLocaleString() : 'Never',
            syncMode: this.plugin.settings.syncDirection,
            autoSyncEnabled: this.plugin.settings.autoSync,
            autoSyncActive: this.plugin.isAutoSyncActive(),
            syncIntervalMinutes: this.plugin.settings.syncInterval / 60000,
            syncIntervalId: this.plugin.syncIntervalId
        };
        
        debugInfo.textContent = JSON.stringify(debugData, null, 2);
        // Auto Sync 수동 테스트 버튼 추가
        const autoSyncTest = debugGroup.createEl('div', { 
            attr: { style: 'margin-top: 15px;' }
        });
        
        const testButton = autoSyncTest.createEl('button', { 
            cls: 'action-button secondary',
            text: '🔍 Debug Auto Sync'
        });
        testButton.onclick = () => {
            this.plugin.debugAutoSyncStatus();
        };        
    }
    private updateAutoSyncStatus(statusEl?: HTMLElement): void {
        if (!statusEl) {
            statusEl = document.querySelector('.auto-sync-status') as HTMLElement;
        }
        
        if (!statusEl) return;

        const isActive = this.plugin.isAutoSyncActive();
        const intervalMinutes = this.plugin.settings.syncInterval / 60000;
        
        if (this.plugin.settings.autoSync && isActive) {
            statusEl.innerHTML = `<span style="color: var(--color-green);">✅ Active - syncing every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}</span>`;
        } else if (this.plugin.settings.autoSync && !isActive) {
            statusEl.innerHTML = `<span style="color: var(--color-orange);">⚠️ Enabled but not running - check console</span>`;
        } else {
            statusEl.innerHTML = `<span style="color: var(--text-muted);">❌ Disabled</span>`;
        }
    }
    private renderLivePreview(container: HTMLElement): void {
        const preview = container.createEl('div', { cls: 'live-preview' });
        preview.createEl('h3', { 
            text: '📊 Sync Overview',
            attr: { style: 'margin: 0 0 20px 0; display: flex; align-items: center; gap: 8px;' }
        });
        
        // Sync Overview Grid
        const overview = preview.createEl('div', { cls: 'sync-overview' });
        
        // Local Files
        const localBox = overview.createEl('div', { cls: 'file-count-box' });
        localBox.createEl('div', { 
            text: '📱',
            attr: { style: 'font-size: 24px; margin-bottom: 8px;' }
        });
        localBox.createEl('div', { 
            text: 'Local Files',
            attr: { style: 'font-weight: bold; margin-bottom: 4px;' }
        });
        const localCount = localBox.createEl('div', { 
            text: 'Click "Refresh" to calculate',
            attr: { style: 'font-size: 14px; color: var(--text-muted);' }
        });
        
        // Sync Action
        const actionBox = overview.createEl('div', { cls: 'sync-action-box' });
        actionBox.createEl('div', { 
            text: '🔄',
            attr: { style: 'font-size: 20px; margin-bottom: 5px;' }
        });
        actionBox.createEl('div', { text: 'Ready to Sync' });
        
        // Remote Files  
        const remoteBox = overview.createEl('div', { cls: 'file-count-box' });
        remoteBox.createEl('div', { 
            text: '☁️',
            attr: { style: 'font-size: 24px; margin-bottom: 8px;' }
        });
        remoteBox.createEl('div', { 
            text: 'Remote Files',
            attr: { style: 'font-weight: bold; margin-bottom: 4px;' }
        });
        const remoteCount = remoteBox.createEl('div', { 
            text: 'Click "Refresh" to calculate',
            attr: { style: 'font-size: 14px; color: var(--text-muted);' }
        });
        
        // What will happen section
        const actions = preview.createEl('div', { 
            attr: { style: 'margin: 20px 0;' }
        });
        
        // Header with inline refresh button - 개선된 레이아웃
        const headerContainer = actions.createEl('div', {
            attr: { 
                style: 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;'
            }
        });
        
        const headerTitle = headerContainer.createEl('h4', { 
            text: '🎯 What will happen:',
            attr: { style: 'margin: 0; flex-grow: 1;' }
        });
        
        const refreshButton = headerContainer.createEl('button', { 
            cls: 'action-button secondary',
            text: '🔄 Refresh',
            attr: { 
                style: 'padding: 6px 12px; font-size: 12px; min-width: 80px; flex-shrink: 0;'
            }
        });
        
        const actionsList = actions.createEl('ul', { 
            attr: { style: 'margin: 10px 0; padding-left: 20px;' }
        });
        
        const uploadLi = actionsList.createEl('li', { text: 'Upload: 📤 Click refresh to calculate' });
        const downloadLi = actionsList.createEl('li', { text: 'Download: 📥 Click refresh to calculate' });
        const conflictLi = actionsList.createEl('li', { text: 'Conflicts: ⚡ Click refresh to calculate' });
        
        const estimatedTime = actions.createEl('div', { 
            text: 'Estimated time: ⏱️ Click refresh to calculate',
            attr: { style: 'margin-top: 10px; font-style: italic; color: var(--text-muted);' }
        });
        
        // Refresh button event handler
        refreshButton.onclick = () => {
            // Show loading state
            refreshButton.disabled = true;
            refreshButton.textContent = '🔄 Loading...';
            
            localCount.textContent = 'Calculating...';
            remoteCount.textContent = 'Calculating...';
            uploadLi.textContent = 'Upload: 📤 Calculating...';
            downloadLi.textContent = 'Download: 📥 Calculating...';
            conflictLi.textContent = 'Conflicts: ⚡ Calculating...';
            estimatedTime.textContent = 'Estimated time: ⏱️ Calculating...';
            
            // Update preview with actual data
            this.updateLivePreview(localCount, remoteCount, uploadLi, downloadLi, conflictLi, estimatedTime)
                .finally(() => {
                    refreshButton.disabled = false;
                    refreshButton.textContent = '🔄 Refresh';
                });
        };
        
        // 🔥 개선된 버튼 레이아웃
        const syncActionsContainer = preview.createEl('div', {
            cls: 'sync-actions-container',
            attr: { 
                style: 'margin-top: 25px; display: flex; flex-direction: column; gap: 12px;'
            }
        });
        
        // Primary Sync Button
        const primarySyncButton = syncActionsContainer.createEl('button', { 
            cls: 'action-button primary sync-primary-button',
            text: '🚀 Start Sync',
            attr: { 
                style: 'width: 100%; padding: 15px 20px; font-size: 16px; font-weight: bold; border-radius: 8px;'
            }
        });
        primarySyncButton.onclick = () => this.plugin.syncWithGoogleDrive(true);
        
        // Secondary Actions Container
        const secondaryActions = syncActionsContainer.createEl('div', {
            cls: 'sync-secondary-actions',
            attr: { 
                style: 'display: grid; grid-template-columns: 1fr 1fr; gap: 10px;'
            }
        });
        
        const uploadOnlyBtn = secondaryActions.createEl('button', { 
            cls: 'action-button secondary sync-secondary-button',
            text: '📤 Upload Only',
            attr: { 
                style: 'padding: 10px 16px; font-size: 14px; border-radius: 6px; text-align: center;'
            }
        });
        uploadOnlyBtn.onclick = () => this.plugin.uploadToGoogleDrive(true);
        
        const downloadOnlyBtn = secondaryActions.createEl('button', { 
            cls: 'action-button secondary sync-secondary-button',
            text: '📥 Download Only',
            attr: { 
                style: 'padding: 10px 16px; font-size: 14px; border-radius: 6px; text-align: center;'
            }
        });
        downloadOnlyBtn.onclick = () => this.plugin.downloadFromGoogleDrive(true);
    }

    private async updateLivePreview(
        localCountEl: HTMLElement, 
        remoteCountEl: HTMLElement,
        uploadEl: HTMLElement,
        downloadEl: HTMLElement,
        conflictEl: HTMLElement,
        timeEl: HTMLElement
    ): Promise<void> {
        try {
            if (!this.plugin.isAuthenticated()) {
                localCountEl.textContent = 'Sign in required';
                remoteCountEl.textContent = 'Sign in required';
                uploadEl.textContent = 'Upload: 📤 Authentication required';
                downloadEl.textContent = 'Download: 📥 Authentication required';
                conflictEl.textContent = 'Conflicts: ⚡ Authentication required';
                timeEl.textContent = 'Estimated time: ⏱️ Please authenticate first';
                return;
            }
    
            // Count local files
            let localFiles: TFile[] = [];
            if (this.plugin.settings.syncWholeVault) {
                localFiles = this.plugin.app.vault.getFiles().filter(file => this.plugin.shouldSyncFileType(file));
            } else {
                for (const driveFolder of this.plugin.settings.selectedDriveFolders) {
                    const folderFiles = await this.plugin.getLocalFilesForDriveFolder(driveFolder);
                    localFiles.push(...folderFiles);
                }
            }
            
            localCountEl.textContent = localFiles.length.toString();
            
            // Count remote files (if authenticated)
            let remoteFiles: any[] = [];
            try {
                if (this.plugin.settings.syncWholeVault) {
                    const rootFolder = await this.plugin.getOrCreateDriveFolder();
                    if (rootFolder) {
                        remoteFiles = await this.plugin.getAllFilesFromDrive(rootFolder.id);
                    }
                } else {
                    for (const driveFolder of this.plugin.settings.selectedDriveFolders) {
                        const folderFiles = await this.plugin.getAllFilesFromDrive(driveFolder.id, driveFolder.path);
                        remoteFiles.push(...folderFiles);
                    }
                }
                
                remoteCountEl.textContent = remoteFiles.length.toString();
                
                // 간단한 파일명 기반 매핑으로 변경
                const localFileNames = new Set(localFiles.map(file => file.name));
                const remoteFileNames = new Set(remoteFiles.map(file => file.name));
                
                // 교집합 계산 (양쪽에 모두 있는 파일 = 잠재적 충돌)
                const commonFiles = new Set([...localFileNames].filter(name => remoteFileNames.has(name)));
                
                // 실제 동기화 작업 계산
                const estimatedUploads = localFiles.length - commonFiles.size; // 로컬에만 있는 파일
                const estimatedDownloads = remoteFiles.length - commonFiles.size; // 원격에만 있는 파일
                const estimatedConflicts = commonFiles.size; // 양쪽에 모두 있는 파일
                
                uploadEl.textContent = `Upload: 📤 ~${estimatedUploads} files`;
                downloadEl.textContent = `Download: 📥 ~${estimatedDownloads} files`;
                if (estimatedUploads === 0 && estimatedDownloads === 0 && estimatedConflicts > 0) {
                    conflictEl.textContent = `Status check: ⚡ ~${estimatedConflicts} files (likely already synced)`;
                } else {
                    conflictEl.textContent = `Conflicts: ⚡ ~${estimatedConflicts} to check`;
                }
                
                const totalActions = estimatedUploads + estimatedDownloads + estimatedConflicts;
                
                if (totalActions === 0) {
                    timeEl.textContent = 'Estimated time: ⏱️ All files are in sync';
                } else {
                    const estimatedSeconds = Math.max(10, totalActions * 2);
                    const minutes = Math.max(1, Math.round(estimatedSeconds / 60));
                    timeEl.textContent = `Estimated time: ⏱️ ~${minutes} minute${minutes !== 1 ? 's' : ''}`;
                }
                
                // 디버그 정보 로그
                console.log('Sync Preview Debug:', {
                    localFiles: localFiles.length,
                    remoteFiles: remoteFiles.length,
                    localFileNames: Array.from(localFileNames),
                    remoteFileNames: Array.from(remoteFileNames),
                    commonFiles: Array.from(commonFiles),
                    estimatedUploads,
                    estimatedDownloads,
                    estimatedConflicts
                });
                
            } catch (error) {
                console.error('Error calculating sync preview:', error);
                remoteCountEl.textContent = 'Error loading';
                uploadEl.textContent = 'Upload: 📤 Unable to calculate';
                downloadEl.textContent = 'Download: 📥 Unable to calculate';
                conflictEl.textContent = 'Conflicts: ⚡ Unable to calculate';
                timeEl.textContent = 'Estimated time: ⏱️ Error calculating';
            }
            
        } catch (error) {
            console.error('Error updating live preview:', error);
            localCountEl.textContent = 'Error';
            remoteCountEl.textContent = 'Error';
        }
    }

    private startStatusUpdates(): void {
        // Update status every 30 seconds
        this.statusUpdateInterval = window.setInterval(() => {
            const statusBar = document.querySelector('.gdrive-quick-status') as HTMLElement;
            if (statusBar) {
                this.updateQuickStatus(statusBar);
            }
        }, 30000);
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
        // Clean up interval when hiding
        if (this.statusUpdateInterval) {
            window.clearInterval(this.statusUpdateInterval);
            this.statusUpdateInterval = null;
        }
        
        // Call parent hide method - PluginSettingTab may not have hide method
        // so we just clean up our resources here
    }
}