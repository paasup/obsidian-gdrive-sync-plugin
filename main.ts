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
    private expandedFolders: Set<string> = new Set();

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
            this.renderFolderTree(contentEl);
        } catch (error) {
            loadingEl.textContent = 'Failed to load folders. Please check your authentication.';
            console.error('Error loading Drive folders:', error);
        }

        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'text-align: right; margin-top: 15px; border-top: 1px solid var(--background-modifier-border); padding-top: 15px;' }
        });

        const createFolderButton = buttonContainer.createEl('button', { 
            text: 'Create New Folder',
            cls: 'mod-cta',
            attr: { style: 'margin-right: 10px;' }
        });
        createFolderButton.onclick = () => this.showCreateFolderDialog();

        const cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel'
        });
        cancelButton.onclick = () => this.close();
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
    
    private renderFolderTree(container: HTMLElement) {
        const treeContainer = container.createEl('div', { 
            cls: 'drive-folder-tree-container',
            attr: { 
                style: 'max-height: 400px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 10px; margin: 10px 0;' 
            }
        });
    
        // 최상위 폴더만 표시 (모든 폴더가 최상위이므로 단순 정렬 후 렌더링)
        const sortedFolders = this.folders.sort((a, b) => a.name.localeCompare(b.name));
    
        if (sortedFolders.length === 0) {
            treeContainer.createEl('p', { 
                text: 'No folders found in Google Drive root folder.',
                attr: { style: 'text-align: center; color: var(--text-muted); margin: 20px 0;' }
            });
            return;
        }
    
        sortedFolders.forEach(folder => {
            this.renderFolderNode(treeContainer, folder, 0);
        });
    }

    private renderFolderNode(container: HTMLElement, folder: DriveFolder, depth: number) {
        const nodeEl = container.createEl('div', { 
            cls: 'drive-folder-tree-node',
            attr: { 
                style: `margin-left: ${depth * 20}px; cursor: pointer; padding: 4px 8px; border-radius: 4px; margin-bottom: 2px;` 
            }
        });
    
        nodeEl.addEventListener('mouseenter', () => {
            nodeEl.style.backgroundColor = 'var(--background-modifier-hover)';
        });
        nodeEl.addEventListener('mouseleave', () => {
            nodeEl.style.backgroundColor = 'transparent';
        });
    
        // 하위 폴더 찾기는 제거 (최상위만 표시하므로)
        const hasChildren = false; // 항상 false로 설정
        const isExpanded = false; // 확장 기능 비활성화
    
        const folderContent = nodeEl.createEl('div', { 
            attr: { style: 'display: flex; align-items: center;' }
        });
    
        // 확장 아이콘 제거 (최상위만 표시하므로 불필요)
        const folderIcon = folderContent.createEl('span', { 
            text: '📁',
            attr: { style: 'margin-right: 8px;' }
        });
    
        const folderName = folderContent.createEl('span', { 
            text: folder.name,
            cls: 'folder-name',
            attr: { style: 'flex-grow: 1; cursor: pointer;' }
        });
    
        const folderPath = folderContent.createEl('small', { 
            text: `(${folder.path || 'root'})`,
            attr: { style: 'margin-left: 10px; color: var(--text-muted); font-size: 0.8em;' }
        });
    
        // 버튼 컨테이너
        const buttonContainer = folderContent.createEl('div', {
            attr: { style: 'margin-left: 10px; display: flex; gap: 5px;' }
        });
    
        const selectBtn = buttonContainer.createEl('button', { 
            text: 'Select',
            cls: 'mod-small mod-cta',
            attr: { 
                style: 'padding: 2px 8px; font-size: 11px;' 
            }
        });
    
        // 삭제 버튼 추가
        const deleteBtn = buttonContainer.createEl('button', { 
            text: 'Delete',
            cls: 'mod-small mod-warning',
            attr: { 
                style: 'padding: 2px 8px; font-size: 11px;' 
            }
        });
    
        // 이벤트 핸들러들
        selectBtn.onclick = (e) => {
            e.stopPropagation();
            this.onChoose(folder);
            this.close();
        };
    
        // 삭제 버튼 이벤트 핸들러
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            
            const success = await this.deleteDriveFolder(folder.id, folder.name);
            if (success) {
                // 폴더 목록 새로고침
                await this.loadDriveFolders();
                this.refreshTree();
            }
        };
    }

    private refreshTree() {
        const { contentEl } = this;
        const existingContainer = contentEl.querySelector('.drive-folder-tree-container');
        if (existingContainer) {
            existingContainer.remove();
        }
        
        // 트리 다시 그리기
        this.renderFolderTree(contentEl);
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
                    await this.loadDriveFolders();
                    this.onOpen();
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

export default class GDriveSyncPlugin extends Plugin {
    settings: GDriveSyncSettings;
    syncIntervalId: number | null = null;
    public isGoogleApiLoaded = false;

    async onload() {
        await this.loadSettings();

        const ribbonIconEl = this.addRibbonIcon('cloud', 'Google Drive Sync', (evt) => {
            this.syncWithGoogleDrive(false);
        });
        ribbonIconEl.addClass('gdrive-sync-ribbon-class');

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

        this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

        console.log('Plugin loaded - Google Drive folder-based sync');

        if (this.settings.autoSync) {
            this.setupAutoSync();
        }
    }

    onunload() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }
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

    async saveSettings() {
        await this.saveData(this.settings);
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
            scope: 'https://www.googleapis.com/auth/drive.file',
            response_type: 'code',
            access_type: 'offline',
            prompt: 'consent'
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    async exchangeCodeForToken(authCode: string): Promise<boolean> {
        try {
            console.log('Exchanging authorization code for access token...');
            
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
                
                this.settings.accessToken = tokenData.access_token;
                await this.saveSettings();
                
                new Notice('✅ Desktop App authentication successful!');
                return true;
            } else {
                console.error('Token exchange failed:', response.status, response.json);
                new Notice('❌ Failed to exchange authorization code for token.');
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

            if (!this.settings.accessToken) {
                console.log('No access token to revoke');
                new Notice('No active session to revoke');
                return true;
            }

            this.settings.accessToken = '';
            await this.saveSettings();

            console.log('✓ Google Drive access revoked successfully');
            new Notice('Google Drive access revoked successfully');
            return true;

        } catch (error) {
            console.error('Failed to revoke access:', error);
            new Notice('Failed to revoke access. Token cleared locally.');
            
            this.settings.accessToken = '';
            await this.saveSettings();
            return false;
        }
    }

    isAuthenticated(): boolean {
        return !!(this.settings.accessToken);
    }

    // 메인 동기화 메서드
    async syncWithGoogleDrive(showProgress: boolean = false): Promise<SyncResult> {
        if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.apiKey) {
            new Notice('Please configure Google Drive API credentials in settings');
            return this.createEmptyResult();
        }
    
        if (!this.settings.syncWholeVault && this.settings.selectedDriveFolders.length === 0) {
            new Notice('Please select Google Drive folders to sync or enable "Sync Whole Vault" in settings');
            return this.createEmptyResult();
        }
    
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
        console.log('Starting upload to Google Drive...');
        const result = this.createEmptyResult();
    
        let progressModal: SyncProgressModal | undefined = undefined;
        
        if (showProgress) {
            progressModal = new SyncProgressModal(this.app);
            progressModal.open();
            progressModal.addLog('🔍 Collecting files to upload...');
            progressModal.updateStatus('Preparing upload...', 'info');
        }
    
        try {
            let allFiles: TFile[] = [];
            let folderTargets: Array<{files: TFile[], folderId: string, name: string}> = [];
    
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
                    name: rootFolder.name
                });
            } else {
                progressModal?.addLog('📂 Sync mode: Selected Folders');
                
                for (const driveFolder of this.settings.selectedDriveFolders) {
                    const localFiles = await this.getLocalFilesForDriveFolder(driveFolder);
                    folderTargets.push({
                        files: localFiles,
                        folderId: driveFolder.id,
                        name: driveFolder.name
                    });
                    allFiles.push(...localFiles);
                }
            }
    
            progressModal?.addLog(`📋 Found ${allFiles.length} files to process`);
            progressModal?.updateProgress(0, allFiles.length);
    
            let processedFiles = 0;
    
            for (const target of folderTargets) {
                if (progressModal?.shouldCancel()) {
                    progressModal.markCancelled();
                    return result;
                }
    
                progressModal?.addLog(`📤 Processing folder: ${target.name} (${target.files.length} files)`);
                
                for (const file of target.files) {
                    if (progressModal?.shouldCancel()) {
                        progressModal.markCancelled();
                        return result;
                    }
    
                    try {
                        progressModal?.updateProgress(processedFiles, allFiles.length, `Uploading: ${file.name}`);
                        progressModal?.addLog(`📤 ${file.path}`);
    
                        const syncResult = await this.syncFileToGoogleDrive(file, target.folderId);
                        
                        if (syncResult === 'skipped') {
                            result.skipped++;
                            progressModal?.addLog(`⏭️ Skipped: ${file.name} (no changes)`);
                        } else if (syncResult === true) {
                            result.uploaded++;
                            progressModal?.addLog(`✅ Uploaded: ${file.name}`);
                        } else {
                            result.errors++;
                            progressModal?.addLog(`❌ Failed: ${file.name}`);
                        }
                    } catch (error) {
                        result.errors++;
                        progressModal?.addLog(`❌ Error uploading ${file.name}: ${error.message || 'Unknown error'}`);
                    }
    
                    processedFiles++;
                    
                    // 작은 지연으로 UI 업데이트 허용
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
    
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();
    
            progressModal?.addLog('🎉 Upload completed successfully!');
    
            // 진행 상태가 표시되지 않는 경우 기존 방식으로 결과 표시
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
        
        // 로컬에서 해당 경로의 폴더 찾기
        const localFolder = this.app.vault.getAbstractFileByPath(localFolderPath);
        
        if (localFolder instanceof TFolder) {
            const files = await this.collectFilesToSync(localFolder, this.settings.includeSubfolders);
            localFiles.push(...files);
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
            if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                relativePath = file.path.substring(baseFolder.length + 1);
            } else if (baseFolder && file.path === baseFolder) {
                relativePath = '';
            }
            localFileMap.set(relativePath, file);
        });
    
        const driveFileMap = new Map<string, any>();
        driveFiles.forEach(file => {
            let relativePath = file.path;
            if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                relativePath = file.path.substring(baseFolder.length + 1);
            }
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
                    progressModal?.addLog(`⚡ Conflict resolution: ${filePath}`);
                    await this.resolveFileConflict(localFile, driveFile, rootFolderId, result);
                } else if (localFile && !driveFile) {
                    progressModal?.addLog(`📤 Upload only: ${filePath}`);
                    await this.uploadSingleFile(localFile, rootFolderId, result, baseFolder);
                } else if (!localFile && driveFile) {
                    progressModal?.addLog(`📥 Download only: ${filePath}`);
                    await this.downloadFileFromDrive(driveFile, result, baseFolder);
                }
            } catch (error) {
                console.error(`Error syncing file ${filePath}:`, error);
                progressModal?.addLog(`❌ Error processing ${filePath}: ${error.message || 'Unknown error'}`);
                result.errors++;
            }
    
            processedFiles++;
            
            // 작은 지연으로 UI 업데이트 허용
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    // Google Drive에서 파일 다운로드
    private async downloadFileFromDrive(driveFile: any, result: SyncResult, baseFolder: string = ''): Promise<void> {
        try {
            let filePath = driveFile.path;
            
            // baseFolder가 있으면 로컬 경로 조정
            if (baseFolder && !filePath.startsWith(baseFolder)) {
                filePath = baseFolder + '/' + filePath;
            }
            
            const localFile = this.app.vault.getAbstractFileByPath(filePath);

            // 로컬 파일이 있는 경우 수정 시간 비교
            if (localFile instanceof TFile) {
                const needsUpdate = await this.shouldDownloadFile(localFile, driveFile);
                if (!needsUpdate) {
                    result.skipped++;
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
                console.log(`🔄 Updated local file: ${filePath}`);
            } else {
                await this.app.vault.create(filePath, content);
                console.log(`📥 Downloaded new file: ${filePath}`);
            }

            // 파일 시간 동기화
            await this.syncFileTime(filePath, remoteModTime);

            result.downloaded++;

        } catch (error) {
            console.error(`Error downloading file ${driveFile.path}:`, error);
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
                    
                    console.log(`⏰ Synced file time: ${filePath} -> ${targetDate.toLocaleString()}`);
                    return;
                } catch (fsError) {
                    console.warn(`⚠️ Direct filesystem access failed: ${fsError}`);
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
                        console.log(`⏰ Updated file stat time: ${filePath} -> ${new Date(targetTime).toLocaleString()}`);
                        return;
                    }
                }
            } catch (obsidianError) {
                console.warn(`⚠️ Obsidian API time sync failed: ${obsidianError}`);
            }
            
        } catch (error) {
            console.warn(`⚠️ File time sync failed for ${filePath}:`, error);
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
    private async resolveFileConflict(localFile: TFile, driveFile: any, rootFolderId: string, result: SyncResult): Promise<void> {
        const localModTime = localFile.stat.mtime;
        const remoteModTime = new Date(driveFile.modifiedTime).getTime();

        let resolution: 'local' | 'remote';

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

        if (resolution === 'local') {
            // 로컬 파일로 원격 파일 업데이트
            await this.uploadSingleFile(localFile, rootFolderId, result);
        } else {
            // 원격 파일로 로컬 파일 업데이트
            await this.downloadFileFromDrive(driveFile, result);
        }

        result.conflicts++;
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
                    const filePath = basePath ? `${basePath}/${file.name}` : file.name;
                    
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
                            path: filePath
                        });
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
                return driveModTime > localModTime;

            case 'checksum':
                try {
                    const localContent = await this.app.vault.read(localFile);
                    const localHash = await this.calculateFileHash(localContent);
                    
                    const driveContent = await this.getFileContentFromDrive(driveFile.id);
                    const driveHash = await this.calculateFileHash(driveContent);
                    
                    return localHash !== driveHash;
                } catch (error) {
                    console.error('Error comparing file checksums:', error);
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

    // Google Drive 관련 메서드들
    async getOrCreateDriveFolder(): Promise<{id: string, name: string} | null> {
        try {
            console.log(`Looking for Google Drive folder: ${this.settings.driveFolder}`);

            const searchResponse = await requestUrl({
                url: `https://www.googleapis.com/drive/v3/files?q=name='${this.settings.driveFolder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`
                },
                throw: false
            });

            if (searchResponse.status === 200) {
                const searchData = searchResponse.json;
                
                if (searchData.files && searchData.files.length > 0) {
                    const folder = searchData.files[0];
                    console.log(`✓ Found existing folder: ${folder.name} (${folder.id})`);
                    return { id: folder.id, name: folder.name };
                }
            }

            console.log(`Creating new Google Drive folder: ${this.settings.driveFolder}`);
            
            const createResponse = await requestUrl({
                url: 'https://www.googleapis.com/drive/v3/files',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: this.settings.driveFolder,
                    mimeType: 'application/vnd.google-apps.folder'
                }),
                throw: false
            });

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
            let relativePath = file.path;
            
            // baseFolder가 있으면 상대 경로로 변환
            if (baseFolder && file.path.startsWith(baseFolder + '/')) {
                relativePath = file.path.substring(baseFolder.length + 1);
            }
            
            let fileName = file.name;
            let targetFolderId = rootFolderId;
            
            if (relativePath.includes('/')) {
                const pathParts = relativePath.split('/');
                fileName = pathParts.pop()!;
                const folderPath = pathParts.join('/');
                
                console.log(`Creating folder structure: ${folderPath}`);
                targetFolderId = await this.createNestedFolders(folderPath, rootFolderId);
                if (!targetFolderId) {
                    console.error(`Failed to create folder structure for: ${folderPath}`);
                    return false;
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
                console.log(`🔄 Updating ${file.path}`);
                return await this.updateFileInDrive(existingFile.id, content, localModTime);
            } else {
                console.log(`📤 Uploading ${file.path}`);
                return await this.uploadFileToDrive(fileName, content, targetFolderId, localModTime);
            }

        } catch (error) {
            console.error(`Error syncing file ${file.path}:`, error);
            return false;
        }
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
                
                return localModTime > driveModTime;

            case 'checksum':
                if (!driveFile) {
                    return true;
                }
                
                try {
                    const localContent = await this.app.vault.read(localFile);
                    const localHash = await this.calculateFileHash(localContent);
                    
                    const driveContent = await this.getFileContentFromDrive(driveFile.id);
                    const driveHash = await this.calculateFileHash(driveContent);
                    
                    return localHash !== driveHash;
                } catch (error) {
                    console.error('Error comparing file checksums:', error);
                    return true;
                }

            default:
                return true;
        }
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
            const response = await requestUrl({
                url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`
                },
                throw: false
            });

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

    private async createNestedFolders(folderPath: string, rootFolderId: string): Promise<string> {
        const pathParts = folderPath.split('/');
        let currentFolderId = rootFolderId;

        for (const folderName of pathParts) {
            if (!folderName) continue;
            
            const existingFolder = await this.findFolderInDrive(folderName, currentFolderId);
            
            if (existingFolder) {
                currentFolderId = existingFolder.id;
                console.log(`✓ Found existing folder: ${folderName}`);
            } else {
                const newFolder = await this.createFolderInDrive(folderName, currentFolderId);
                if (!newFolder) {
                    throw new Error(`Failed to create folder: ${folderName}`);
                }
                currentFolderId = newFolder.id;
                console.log(`📁 Created folder: ${folderName}`);
            }
        }

        return currentFolderId;
    }

    private async findFolderInDrive(folderName: string, parentFolderId: string): Promise<{id: string, name: string} | null> {
        try {
            const response = await requestUrl({
                url: `https://www.googleapis.com/drive/v3/files?q=name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`
                },
                throw: false
            });

            if (response.status === 200) {
                const data = response.json;
                if (data.files && data.files.length > 0) {
                    return data.files[0];
                }
            }
            return null;
        } catch (error) {
            console.error('Error searching folder in Drive:', error);
            return null;
        }
    }

    private async createFolderInDrive(folderName: string, parentFolderId: string): Promise<{id: string, name: string} | null> {
        try {
            const response = await requestUrl({
                url: 'https://www.googleapis.com/drive/v3/files',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: folderName,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [parentFolderId]
                }),
                throw: false
            });

            if (response.status === 200 || response.status === 201) {
                const folderData = response.json;
                return { id: folderData.id, name: folderData.name };
            } else {
                console.error('Failed to create folder:', response.status, response.json);
                return null;
            }
        } catch (error) {
            console.error('Error creating folder in Drive:', error);
            return null;
        }
    }

    private async findFileInDrive(fileName: string, folderId: string): Promise<{id: string, name: string, modifiedTime: string} | null> {
        try {
            const response = await requestUrl({
                url: `https://www.googleapis.com/drive/v3/files?q=name='${fileName}' and '${folderId}' in parents and trashed=false&fields=files(id,name,modifiedTime)`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`
                },
                throw: false
            });

            if (response.status === 200) {
                const data = response.json;
                if (data.files && data.files.length > 0) {
                    return data.files[0];
                }
            }
            return null;
        } catch (error) {
            console.error('Error searching file in Drive:', error);
            return null;
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

            const response = await requestUrl({
                url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`,
                    'Content-Type': `multipart/related; boundary="${boundary}"`
                },
                body: body,
                throw: false
            });

            return response.status === 200 || response.status === 201;
        } catch (error) {
            console.error('Error uploading file to Drive:', error);
            return false;
        }
    }

    private async updateFileInDrive(fileId: string, content: string, localModTime: number): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`,
                    'Content-Type': 'text/plain'
                },
                body: content,
                throw: false
            });

            return response.status === 200;
        } catch (error) {
            console.error('Error updating file in Drive:', error);
            return false;
        }
    }

    setupAutoSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
        }

        this.syncIntervalId = window.setInterval(() => {
            this.syncWithGoogleDrive();
        }, this.settings.syncInterval);
    }

    resetGoogleAPIState() {
        console.log('Resetting Google API state...');
        this.isGoogleApiLoaded = false;
        console.log('Google API state reset completed');
    }

    async testDriveAPIConnection(): Promise<boolean> {
        try {
            if (!this.settings.accessToken) {
                console.log('No access token available for testing');
                new Notice('❌ Please authenticate first');
                return false;
            }

            console.log('Testing Google Drive API connection...');
            
            const response = await requestUrl({
                url: 'https://www.googleapis.com/drive/v3/about?fields=user',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`
                },
                throw: false
            });

            console.log('API Response Status:', response.status);

            if (response.status === 200) {
                const data = response.json;
                console.log('Drive API test successful:', data);
                new Notice(`✅ Drive API connection successful. User: ${data.user?.displayName || 'Unknown'}`);
                return true;
            } else if (response.status === 401) {
                console.error('Authentication failed - Token expired or invalid');
                new Notice('❌ Authentication expired. Please sign in again.');
                
                this.settings.accessToken = '';
                await this.saveSettings();
                
                new Notice('Click "1. Open Auth URL" again to re-authenticate.');
                return false;
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
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'Google Drive Folder-Based Sync Settings' });

        // Google Drive API Configuration
        containerEl.createEl('h3', { text: 'Google Drive API Configuration' });

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('Google Drive API Client ID (Desktop Application type)')
            .addText(text => text
                .setPlaceholder('Enter your Client ID')
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Client Secret')
            .setDesc('Google Drive API Client Secret (from Google Cloud Console)')
            .addText(text => text
                .setPlaceholder('Enter your Client Secret')
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('Google Drive API Key (from Google Cloud Console)')
            .addText(text => text
                .setPlaceholder('Enter your API Key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        // Authentication
        containerEl.createEl('h3', { text: 'Authentication' });

        new Setting(containerEl)
            .setName('Check Configuration')
            .setDesc('Verify that Client ID, Client Secret, and API Key are properly configured')
            .addButton(button => button
                .setButtonText('Check')
                .onClick(() => {
                    if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret || !this.plugin.settings.apiKey) {
                        new Notice('❌ Please set Client ID, Client Secret, and API Key');
                    } else {
                        new Notice('✅ Configuration looks good! You can now authenticate.');
                    }
                }));

        new Setting(containerEl)
            .setName('Desktop App Authentication')
            .setDesc('Authenticate with Google Drive using Desktop Application Client ID')
            .addButton(button => button
                .setButtonText('1. Open Auth URL')
                .setCta()
                .onClick(async () => {
                    if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
                        new Notice('❌ Please set Client ID and Client Secret first');
                        return;
                    }
                    
                    await this.plugin.authenticateGoogleDrive();
                }));

        new Setting(containerEl)
            .setName('Authorization Code')
            .setDesc('Step 2: After authentication, paste the authorization code here')
            .addText(text => text
                .setPlaceholder('Paste authorization code here...')
                .setValue('')
                .onChange(async (value) => {
                    // 값 저장하지 않음 (일회성)
                }))
            .addButton(button => button
                .setButtonText('2. Exchange for Token')
                .setCta()
                .onClick(async (evt) => {
                    const textInput = containerEl.querySelector('input[placeholder="Paste authorization code here..."]') as HTMLInputElement;
                    const authCode = textInput?.value?.trim();
                    
                    if (!authCode) {
                        new Notice('❌ Please enter authorization code first');
                        return;
                    }
                    
                    console.log('Attempting to exchange authorization code...');
                    const success = await this.plugin.exchangeCodeForToken(authCode);
                    
                    if (success) {
                        if (textInput) textInput.value = '';
                        
                        setTimeout(async () => {
                            await this.plugin.testDriveAPIConnection();
                        }, 1000);
                    }
                }));

        // Sync Configuration
        containerEl.createEl('h3', { text: 'Sync Configuration' });

        new Setting(containerEl)
            .setName('Google Drive Root Folder')
            .setDesc('Name of the root folder to create/use in Google Drive')
            .addText(text => text
                .setPlaceholder('e.g., Obsidian-Sync')
                .setValue(this.plugin.settings.driveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.driveFolder = value;
                    await this.plugin.saveSettings();
                }));

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

        new Setting(containerEl)
            .setName('Create Missing Folders')
            .setDesc('Automatically create local folders when downloading files from Google Drive')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createMissingFolders)
                .onChange(async (value) => {
                    this.plugin.settings.createMissingFolders = value;
                    await this.plugin.saveSettings();
                }));

        // Sync Whole Vault Option
        new Setting(containerEl)
            .setName('Sync Whole Vault')
            .setDesc('Enable to sync the entire vault instead of selected Google Drive folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncWholeVault)
                .onChange(async (value) => {
                    this.plugin.settings.syncWholeVault = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh the settings display
                }));

        // Google Drive Folders Section (only show when not syncing whole vault)
        if (!this.plugin.settings.syncWholeVault) {
            const syncFoldersSection = containerEl.createEl('div', { cls: 'sync-folders-section' });
            syncFoldersSection.createEl('h4', { text: 'Google Drive Folders to Sync' });

            // Current selected Drive folders display
            const currentFoldersEl = syncFoldersSection.createEl('div', { cls: 'current-drive-folders' });
            this.updateCurrentDriveFoldersDisplay(currentFoldersEl);

            // Add Google Drive folder button
            new Setting(syncFoldersSection)
            .setName('Select Google Drive Folder')
            .setDesc('Choose top-level folders from Google Drive to sync with local vault')  // 설명 수정
            .addButton(button => button
                .setButtonText('Browse Google Drive')
                .setCta()
                .onClick(async () => {
                    if (!this.plugin.isAuthenticated()) {
                        new Notice('❌ Please authenticate with Google Drive first');
                        return;
                    }
                    await this.openDriveFolderSelector();
                }));

            // Clear all folders button
            new Setting(syncFoldersSection)
                .setName('Clear All Folders')
                .setDesc('Remove all selected Google Drive folders')
                .addButton(button => button
                    .setButtonText('Clear All')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.selectedDriveFolders = [];
                        await this.plugin.saveSettings();
                        this.updateCurrentDriveFoldersDisplay(currentFoldersEl);
                        new Notice('All Google Drive folders cleared');
                    }));
        }

        new Setting(containerEl)
            .setName('Include Subfolders')
            .setDesc('Sync files from subfolders recursively')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeSubfolders)
                .onChange(async (value) => {
                    this.plugin.settings.includeSubfolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto Sync')
            .setDesc('Automatically sync at regular intervals')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.setupAutoSync();
                    } else if (this.plugin.syncIntervalId) {
                        window.clearInterval(this.plugin.syncIntervalId);
                        this.plugin.syncIntervalId = null;
                    }
                }));

        new Setting(containerEl)
            .setName('Sync Interval')
            .setDesc('How often to sync (in minutes)')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.syncInterval / 60000)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = value * 60000;
                    await this.plugin.saveSettings();
                    if (this.plugin.settings.autoSync) {
                        this.plugin.setupAutoSync();
                    }
                }));

        new Setting(containerEl)
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


        // Sync Actions
        containerEl.createEl('h3', { text: 'Sync Actions' });

        new Setting(containerEl)
            .setName('Full Bidirectional Sync')
            .setDesc('Perform complete bidirectional synchronization with detailed progress')
            .addButton(button => button
                .setButtonText('🔄 Sync Both Ways')
                .setCta()
                .onClick(async () => {
                    const originalDirection = this.plugin.settings.syncDirection;
                    this.plugin.settings.syncDirection = 'bidirectional';
                    
                    try {
                        await this.plugin.bidirectionalSync(true); // 진행 상태 표시
                    } finally {
                        this.plugin.settings.syncDirection = originalDirection;
                    }
                }));

        new Setting(containerEl)
            .setName('Upload to Google Drive')
            .setDesc('Upload only: Send local files to Google Drive with progress tracking')
            .addButton(button => button
                .setButtonText('📤 Upload Only')
                .onClick(async () => {
                    await this.plugin.uploadToGoogleDrive(true); // 진행 상태 표시
                }));

        new Setting(containerEl)
            .setName('Download from Google Drive')
            .setDesc('Download only: Get files from Google Drive with progress tracking')
            .addButton(button => button
                .setButtonText('📥 Download Only')
                .onClick(async () => {
                    await this.plugin.downloadFromGoogleDrive(true); // 진행 상태 표시
                }));

        new Setting(containerEl)
            .setName('Preview Sync')
            .setDesc('Show what files would be synced (without actually syncing)')
            .addButton(button => button
                .setButtonText('Preview')
                .onClick(async () => {
                    await this.previewSync();
                }));

        // Testing & Debugging
        containerEl.createEl('h3', { text: 'Testing & Debugging' });

        new Setting(containerEl)
            .setName('Test API Connection')
            .setDesc('Test your current access token with Google Drive API')
            .addButton(button => button
                .setButtonText('Test Connection')
                .onClick(async () => {
                    await this.plugin.testDriveAPIConnection();
                }));

        new Setting(containerEl)
            .setName('Browse Google Drive Folders')
            .setDesc('View and manage Google Drive folder structure')
            .addButton(button => button
                .setButtonText('Browse Folders')
                .onClick(async () => {
                    if (!this.plugin.isAuthenticated()) {
                        new Notice('❌ Please authenticate with Google Drive first');
                        return;
                    }
                    await this.openDriveFolderBrowser();
                }));

        new Setting(containerEl)
            .setName('Sign Out')
            .setDesc('Revoke Google Drive access and sign out')
            .addButton(button => button
                .setButtonText('Sign Out')
                .setWarning()
                .onClick(async () => {
                    await this.plugin.revokeGoogleDriveAccess();
                    this.display(); // Refresh display
                }));

        // Authentication Status
        containerEl.createEl('h3', { text: 'Status Information' });
        const statusEl = containerEl.createEl('div');

        const updateStatus = () => {
            const isAuth = this.plugin.isAuthenticated();
            const selectedFoldersCount = this.plugin.settings.selectedDriveFolders.length;
            
            statusEl.innerHTML = `
                <div style="padding: 10px; border-radius: 4px; margin-bottom: 10px; ${isAuth ? 
                    'background-color: #d4edda; border: 1px solid #c3e6cb; color: #155724;' : 
                    'background-color: #f8d7da; border: 1px solid #f5c6cb; color: #721c24;'}">
                    <strong>Authentication:</strong> ${isAuth ? '✅ Authenticated' : '❌ Not Authenticated'}
                    ${this.plugin.settings.accessToken ? 
                        '<br><small>Access token is stored</small>' : 
                        '<br><small>No access token stored</small>'}
                </div>
                <div style="padding: 10px; border-radius: 4px; margin-bottom: 10px; background-color: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460;">
                    <strong>Sync Mode:</strong> ${this.plugin.settings.syncWholeVault ? 
                        '📁 Whole Vault' : 
                        `📂 Selected Folders (${selectedFoldersCount} selected)`}
                    <br><small>Google Drive Root: ${this.plugin.settings.driveFolder}</small>
                    <br><small>Sync Direction: ${this.plugin.settings.syncDirection === 'bidirectional' ? '🔄 Bidirectional' : 
                        this.plugin.settings.syncDirection === 'upload' ? '📤 Upload Only' : '📥 Download Only'}</small>
                    <br><small>Conflict Resolution: ${this.plugin.settings.conflictResolution === 'newer' ? '🕒 Use Newer File' :
                        this.plugin.settings.conflictResolution === 'local' ? '📱 Always Use Local' :
                        this.plugin.settings.conflictResolution === 'remote' ? '☁️ Always Use Remote' : '❓ Ask User'}</small>
                    ${this.plugin.settings.lastSyncTime ? 
                        `<br><small>Last Sync: ${new Date(this.plugin.settings.lastSyncTime).toLocaleString()}</small>` : 
                        '<br><small>Never synced</small>'}
                </div>
            `;
        };

        updateStatus();

        // Setup Instructions
        containerEl.createEl('h3', { text: 'Setup Instructions' });
        const instructionsEl = containerEl.createEl('div');
        instructionsEl.innerHTML = `
        <div style="background-color: #d4edda; border: 1px solid #c3e6cb; padding: 10px; margin: 10px 0; border-radius: 4px;">
            <p><strong>✅ Google Cloud Console 설정:</strong></p>
            <ol>
                <li><a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console - Credentials</a> 접속</li>
                <li>"Create Credentials" → "OAuth client ID" 선택</li>
                <li><strong>Application type: "Desktop application"</strong> 선택</li>
                <li>Name 입력 후 "Create" 클릭</li>
                <li>생성된 Client ID와 Client Secret을 위 설정에 입력</li>
                <li>Google Drive API가 활성화되어 있는지 확인</li>
            </ol>
        </div>
        <div style="background-color: #e7f3ff; border: 1px solid #b3d7ff; padding: 10px; margin: 10px 0; border-radius: 4px;">
            <p><strong>🔄 Google Drive 기반 동기화:</strong></p>
            <ul>
                <li><strong>📁 Whole Vault:</strong> 전체 볼트를 Google Drive 루트 폴더와 동기화</li>
                <li><strong>📂 Selected Folders:</strong> Google Drive에서 선택한 최상위 폴더들만 로컬과 동기화</li>
                <li><strong>🏗️ 폴더 생성:</strong> Google Drive에서 새 최상위 폴더를 생성하고 선택 가능</li>
                <li><strong>🗑️ 폴더 삭제:</strong> Google Drive의 최상위 폴더를 휴지통으로 이동</li>
                <li><strong>🔍 폴더 브라우징:</strong> Google Drive 최상위 폴더 구조를 탐색하고 관리</li>
            </ul>
            <p><strong>💡 사용 방법:</strong></p>
            <ol>
                <li>Google Cloud Console에서 API 설정 완료</li>
                <li>Desktop App Authentication으로 인증</li>
                <li>"Browse Google Drive" 버튼으로 최상위 폴더 구조 확인</li>
                <li>동기화할 Google Drive 최상위 폴더 선택</li>
                <li>선택된 폴더들이 로컬 경로와 자동 매핑되어 동기화</li>
            </ol>
        </div>
        <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; margin: 10px 0; border-radius: 4px;">
            <p><strong>⚠️ 중요사항:</strong></p>
            <ul>
                <li>최상위 폴더만 선택 가능하며, 하위 폴더는 자동으로 포함됩니다</li>
                <li>Google Drive에서 선택한 폴더 경로가 로컬 볼트 경로와 일치해야 합니다</li>
                <li>예: Google Drive의 "Notes" 폴더는 로컬의 "Notes" 폴더와 동기화</li>
                <li>폴더 삭제 시 Google Drive 휴지통으로 이동되므로 복구 가능합니다</li>
                <li>"Whole Vault" 모드에서는 모든 폴더가 동기화됩니다</li>
            </ul>
        </div>
        `;
    }

    // 현재 선택된 Google Drive 폴더들 표시 업데이트
    private updateCurrentDriveFoldersDisplay(containerEl: HTMLElement) {
        containerEl.empty();
        
        if (this.plugin.settings.selectedDriveFolders.length === 0) {
            containerEl.createEl('p', { text: 'No Google Drive folders selected for sync', cls: 'setting-item-description' });
            return;
        }

        containerEl.createEl('p', { text: 'Selected Google Drive folders:', cls: 'setting-item-description' });
        
        const folderList = containerEl.createEl('div', { cls: 'sync-drive-folders-list' });
        
        this.plugin.settings.selectedDriveFolders.forEach((folder, index) => {
            const folderItem = folderList.createEl('div', { 
                cls: 'sync-drive-folder-item',
                attr: { style: 'display: flex; align-items: center; margin-bottom: 5px; padding: 8px; background-color: var(--background-secondary); border-radius: 3px;' }
            });
            
            const folderIcon = folderItem.createEl('span', { 
                text: '☁️',
                attr: { style: 'margin-right: 8px;' }
            });
            
            const folderInfo = folderItem.createEl('div', { 
                attr: { style: 'flex-grow: 1; margin-right: 10px;' }
            });
            
            const folderName = folderInfo.createEl('div', { 
                text: folder.name,
                attr: { style: 'font-weight: bold;' }
            });
            
            const folderPath = folderInfo.createEl('small', { 
                text: `Path: ${folder.path || '/'}`,
                attr: { style: 'color: var(--text-muted); font-size: 0.8em;' }
            });
            
            const folderId = folderInfo.createEl('small', { 
                text: `ID: ${folder.id}`,
                attr: { style: 'color: var(--text-muted); font-size: 0.8em; display: block;' }
            });
            
            const removeButton = folderItem.createEl('button', { 
                text: '✖',
                cls: 'mod-warning',
                attr: { style: 'min-width: 24px; height: 24px; padding: 0; border-radius: 3px;' }
            });
            
            removeButton.onclick = async () => {
                this.plugin.settings.selectedDriveFolders.splice(index, 1);
                await this.plugin.saveSettings();
                this.updateCurrentDriveFoldersDisplay(containerEl);
                new Notice(`Removed Google Drive folder: ${folder.name}`);
            };
        });
    }

    // Google Drive 폴더 선택 모달 열기
    private async openDriveFolderSelector() {
        const modal = new DriveFolderModal(this.app, this.plugin, async (selectedFolder) => {
            // 이미 선택된 폴더인지 확인
            const alreadySelected = this.plugin.settings.selectedDriveFolders.some(
                folder => folder.id === selectedFolder.id
            );
            
            if (alreadySelected) {
                new Notice(`Folder "${selectedFolder.name}" is already selected`);
                return;
            }
            
            // 선택된 폴더 추가
            this.plugin.settings.selectedDriveFolders.push({
                id: selectedFolder.id,
                name: selectedFolder.name,
                path: selectedFolder.path
            });
            
            await this.plugin.saveSettings();
            
            // 디스플레이 업데이트
            const currentFoldersEl = document.querySelector('.current-drive-folders') as HTMLElement;
            if (currentFoldersEl) {
                this.updateCurrentDriveFoldersDisplay(currentFoldersEl);
            }
            
            new Notice(`Added Google Drive folder: ${selectedFolder.name}`);
        });
        
        modal.open();
    }

    // Google Drive 폴더 브라우저 열기 (관리용)
    private async openDriveFolderBrowser() {
        const modal = new DriveFolderModal(this.app, this.plugin, (selectedFolder) => {
            console.log('Selected folder for browsing:', selectedFolder);
            new Notice(`Folder info: ${selectedFolder.name} (${selectedFolder.path})`);
        });
        
        modal.open();
    }

    // 동기화 미리보기
    private async previewSync() {
        if (!this.plugin.isAuthenticated()) {
            new Notice('❌ Please authenticate first');
            return;
        }

        try {
            console.log('=== GOOGLE DRIVE FOLDER-BASED SYNC PREVIEW ===');
            console.log(`Google Drive root folder: ${this.plugin.settings.driveFolder}`);
            console.log(`Sync direction: ${this.plugin.settings.syncDirection}`);
            console.log(`Sync whole vault: ${this.plugin.settings.syncWholeVault}`);
            console.log(`Selected Drive folders: ${this.plugin.settings.selectedDriveFolders.length}`);

            if (this.plugin.settings.syncWholeVault) {
                // 전체 볼트 미리보기
                const localFiles = this.plugin.app.vault.getFiles().filter(file => this.plugin.shouldSyncFileType(file));
                console.log(`\n📱 LOCAL FILES (Whole Vault): ${localFiles.length} files`);
                
                const rootFolder = await this.plugin.getOrCreateDriveFolder();
                if (rootFolder) {
                    const driveFiles = await this.plugin.getAllFilesFromDrive(rootFolder.id);
                    console.log(`☁️ GOOGLE DRIVE FILES: ${driveFiles.length} files`);
                    
                    const summary = `📋 Preview: ${localFiles.length} local files, ${driveFiles.length} remote files`;
                    new Notice(summary);
                }
            } else {
                // 선택된 폴더들 미리보기
                if (this.plugin.settings.selectedDriveFolders.length === 0) {
                    new Notice('❌ No Google Drive folders selected');
                    return;
                }

                let totalLocalFiles = 0;
                let totalDriveFiles = 0;

                console.log(`\n📂 SELECTED GOOGLE DRIVE FOLDERS (${this.plugin.settings.selectedDriveFolders.length}):`);
                
                for (const driveFolder of this.plugin.settings.selectedDriveFolders) {
                    console.log(`\n📁 Processing: ${driveFolder.name} (${driveFolder.path})`);
                    
                    // 로컬 파일 수집
                    const localFiles = await this.plugin.getLocalFilesForDriveFolder(driveFolder);
                    totalLocalFiles += localFiles.length;
                    console.log(`  📱 Local files: ${localFiles.length}`);
                    
                    // Google Drive 파일 수집
                    const driveFiles = await this.plugin.getAllFilesFromDrive(driveFolder.id, driveFolder.path);
                    totalDriveFiles += driveFiles.length;
                    console.log(`  ☁️ Drive files: ${driveFiles.length}`);
                }

                const summary = `📋 Preview: ${totalLocalFiles} local files, ${totalDriveFiles} remote files in ${this.plugin.settings.selectedDriveFolders.length} folders`;
                console.log(`\n${summary}`);
                new Notice(summary + '. Check console for details.');
            }

        } catch (error) {
            console.error('Preview sync error:', error);
            new Notice('❌ Failed to preview sync. Check console for details.');
        }
    }
}