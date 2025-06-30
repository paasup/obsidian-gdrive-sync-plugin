import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, requestUrl, FuzzySuggestModal, Modal } from 'obsidian';

interface GDriveSyncSettings {
    clientId: string;
    clientSecret: string;
    apiKey: string;
    syncFolders: string[];
    syncWholeVault: boolean;
    autoSync: boolean;
    syncInterval: number;
    accessToken: string;
    driveFolder: string;
    includeSubfolders: boolean;
    syncMode: 'always' | 'modified' | 'checksum';
    lastSyncTime: number;
    syncDirection: 'upload' | 'download' | 'bidirectional'; // 새로 추가
    conflictResolution: 'local' | 'remote' | 'newer' | 'ask'; // 새로 추가
    createMissingFolders: boolean; // 새로 추가
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
    syncDirection: 'bidirectional', // 기본값: 양방향
    conflictResolution: 'newer', // 기본값: 더 최신 파일 우선
    createMissingFolders: true // 기본값: 누락된 폴더 자동 생성
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

// 폴더 트리 선택 모달 클래스
class FolderTreeModal extends Modal {
    private plugin: GDriveSyncPlugin;
    private onChoose: (folder: TFolder) => void;
    private expandedFolders: Set<string> = new Set();

    constructor(app: App, plugin: GDriveSyncPlugin, onChoose: (folder: TFolder) => void) {
        super(app);
        this.plugin = plugin;
        this.onChoose = onChoose;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Select Folder to Sync' });
        
        const treeContainer = contentEl.createEl('div', { 
            cls: 'folder-tree-container',
            attr: { 
                style: 'max-height: 400px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 10px; margin: 10px 0;' 
            }
        });

        this.renderFolderTree(treeContainer);

        const buttonContainer = contentEl.createEl('div', { 
            attr: { style: 'text-align: right; margin-top: 15px;' }
        });

        const cancelButton = buttonContainer.createEl('button', { 
            text: 'Cancel',
            attr: { style: 'margin-right: 10px;' }
        });
        cancelButton.onclick = () => this.close();

        const selectRootButton = buttonContainer.createEl('button', { 
            text: 'Select Vault Root',
            cls: 'mod-cta',
            attr: { style: 'margin-right: 10px;' }
        });
        selectRootButton.onclick = () => {
            this.onChoose(this.app.vault.getRoot());
            this.close();
        };
    }

    private renderFolderTree(container: HTMLElement) {
        const rootFolder = this.app.vault.getRoot();
        const rootFolders = rootFolder.children
            .filter(child => child instanceof TFolder)
            .sort((a, b) => a.name.localeCompare(b.name)) as TFolder[];

        rootFolders.forEach(folder => {
            this.renderFolderNode(container, folder, 0);
        });
    }

    private renderFolderNode(container: HTMLElement, folder: TFolder, depth: number) {
        const nodeEl = container.createEl('div', { 
            cls: 'folder-tree-node',
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

        const hasChildren = folder.children.some(child => child instanceof TFolder);
        const isExpanded = this.expandedFolders.has(folder.path);

        const folderContent = nodeEl.createEl('div', { 
            attr: { style: 'display: flex; align-items: center;' }
        });

        const expandIcon = folderContent.createEl('span', { 
            text: hasChildren ? (isExpanded ? '▼' : '▶') : '  ',
            attr: { 
                style: 'margin-right: 8px; width: 12px; display: inline-block; font-size: 10px;' 
            }
        });

        const folderIcon = folderContent.createEl('span', { 
            text: '📁',
            attr: { style: 'margin-right: 6px;' }
        });

        const folderName = folderContent.createEl('span', { 
            text: folder.name || 'Vault Root',
            attr: { style: 'flex-grow: 1;' }
        });

        const selectBtn = folderContent.createEl('button', { 
            text: 'Select',
            cls: 'mod-small',
            attr: { 
                style: 'margin-left: 10px; padding: 2px 8px; font-size: 11px;' 
            }
        });

        expandIcon.onclick = (e) => {
            e.stopPropagation();
            if (hasChildren) {
                this.toggleFolder(folder.path, container);
            }
        };

        folderName.onclick = () => {
            if (hasChildren) {
                this.toggleFolder(folder.path, container);
            }
        };

        selectBtn.onclick = (e) => {
            e.stopPropagation();
            this.onChoose(folder);
            this.close();
        };

        if (hasChildren && isExpanded) {
            const subFolders = folder.children
                .filter(child => child instanceof TFolder)
                .sort((a, b) => a.name.localeCompare(b.name)) as TFolder[];

            subFolders.forEach(subFolder => {
                this.renderFolderNode(container, subFolder, depth + 1);
            });
        }
    }

    private toggleFolder(folderPath: string, container: HTMLElement) {
        if (this.expandedFolders.has(folderPath)) {
            this.expandedFolders.delete(folderPath);
        } else {
            this.expandedFolders.add(folderPath);
        }
        
        container.empty();
        this.renderFolderTree(container);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    private folders: TFolder[];
    private onChoose: (folder: TFolder) => void;

    constructor(app: App, folders: TFolder[], onChoose: (folder: TFolder) => void) {
        super(app);
        this.folders = folders;
        this.onChoose = onChoose;
    }

    getItems(): TFolder[] {
        return this.folders;
    }

    getItemText(folder: TFolder): string {
        return folder.path || '/';
    }

    onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(folder);
    }
}

export default class GDriveSyncPlugin extends Plugin {
    settings: GDriveSyncSettings;
    syncIntervalId: number | null = null;
    public isGoogleApiLoaded = false;

    async onload() {
        await this.loadSettings();

        const ribbonIconEl = this.addRibbonIcon('cloud', 'Google Drive Sync', (evt) => {
            this.syncWithGoogleDrive();
        });
        ribbonIconEl.addClass('gdrive-sync-ribbon-class');

        this.addCommand({
            id: 'sync-with-gdrive',
            name: 'Sync with Google Drive',
            callback: () => {
                this.syncWithGoogleDrive();
            }
        });

        // 새로운 커맨드들 추가
        this.addCommand({
            id: 'download-from-gdrive',
            name: 'Download from Google Drive',
            callback: () => {
                this.downloadFromGoogleDrive();
            }
        });

        this.addCommand({
            id: 'upload-to-gdrive',
            name: 'Upload to Google Drive',
            callback: () => {
                this.uploadToGoogleDrive();
            }
        });

        this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

        console.log('Plugin loaded - Desktop App authentication mode with bidirectional sync support');

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
        
        const oldData = await this.loadData();
        if (oldData && oldData.syncFolder && !oldData.syncFolders) {
            this.settings.syncFolders = [oldData.syncFolder];
            await this.saveSettings();
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // 기존 인증 메서드들은 동일하게 유지
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

    // 메인 동기화 메서드 (양방향)
    async syncWithGoogleDrive(): Promise<SyncResult> {
        if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.apiKey) {
            new Notice('Please configure Google Drive API credentials in settings');
            return this.createEmptyResult();
        }

        if (!this.settings.syncWholeVault && this.settings.syncFolders.length === 0) {
            new Notice('Please select folders to sync or enable "Sync Whole Vault" in settings');
            return this.createEmptyResult();
        }

        new Notice('Starting Google Drive sync...');

        try {
            if (!this.isAuthenticated()) {
                new Notice('Please authenticate first using the Desktop App method.');
                return this.createEmptyResult();
            }

            let result: SyncResult;

            if (this.settings.syncDirection === 'upload') {
                result = await this.uploadToGoogleDrive();
            } else if (this.settings.syncDirection === 'download') {
                result = await this.downloadFromGoogleDrive();
            } else {
                // 양방향 동기화
                result = await this.bidirectionalSync();
            }

            this.reportSyncResult(result);
            return result;

        } catch (error) {
            console.error('Sync failed:', error);
            new Notice('Google Drive sync failed');
            return this.createEmptyResult();
        }
    }

    // 업로드 전용 메서드
    async uploadToGoogleDrive(): Promise<SyncResult> {
        console.log('Starting upload to Google Drive...');
        const result = this.createEmptyResult();

        try {
            const driveFolder = await this.getOrCreateDriveFolder();
            if (!driveFolder) {
                new Notice('❌ Failed to create or find Google Drive folder');
                return result;
            }

            if (this.settings.syncWholeVault) {
                const allFiles = this.app.vault.getFiles();
                const filesToSync = allFiles.filter(file => this.shouldSyncFileType(file));
                
                await this.uploadFilesToDrive(filesToSync, driveFolder.id, result);
            } else {
                for (const folderPath of this.settings.syncFolders) {
                    const folder = this.app.vault.getAbstractFileByPath(folderPath);
                    if (folder && folder instanceof TFolder) {
                        const filesToSync = await this.collectFilesToSync(folder, this.settings.includeSubfolders);
                        await this.uploadFilesToDrive(filesToSync, driveFolder.id, result);
                    }
                }
            }

            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();

        } catch (error) {
            console.error('Upload error:', error);
            result.errors++;
        }

        return result;
    }

    // 다운로드 전용 메서드
    async downloadFromGoogleDrive(): Promise<SyncResult> {
        console.log('Starting download from Google Drive...');
        const result = this.createEmptyResult();

        try {
            const driveFolder = await this.getOrCreateDriveFolder();
            if (!driveFolder) {
                new Notice('❌ Failed to find Google Drive folder');
                return result;
            }

            // Google Drive에서 모든 파일 가져오기
            const driveFiles = await this.getAllFilesFromDrive(driveFolder.id);
            console.log(`Found ${driveFiles.length} files in Google Drive`);

            for (const driveFile of driveFiles) {
                try {
                    await this.downloadFileFromDrive(driveFile, result);
                } catch (error) {
                    console.error(`Error downloading file ${driveFile.name}:`, error);
                    result.errors++;
                }
            }

            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();

        } catch (error) {
            console.error('Download error:', error);
            result.errors++;
        }

        return result;
    }

    // 양방향 동기화 메서드
    async bidirectionalSync(): Promise<SyncResult> {
        console.log('Starting bidirectional sync...');
        const result = this.createEmptyResult();

        try {
            const driveFolder = await this.getOrCreateDriveFolder();
            if (!driveFolder) {
                new Notice('❌ Failed to create or find Google Drive folder');
                return result;
            }

            // 1. 로컬 파일 수집
            let localFiles: TFile[] = [];
            if (this.settings.syncWholeVault) {
                const allFiles = this.app.vault.getFiles();
                localFiles = allFiles.filter(file => this.shouldSyncFileType(file));
            } else {
                for (const folderPath of this.settings.syncFolders) {
                    const folder = this.app.vault.getAbstractFileByPath(folderPath);
                    if (folder && folder instanceof TFolder) {
                        const folderFiles = await this.collectFilesToSync(folder, this.settings.includeSubfolders);
                        localFiles.push(...folderFiles);
                    }
                }
            }

            // 2. 원격 파일 수집
            const driveFiles = await this.getAllFilesFromDrive(driveFolder.id);

            // 3. 파일 매핑 생성 (경로 기준)
            const localFileMap = new Map<string, TFile>();
            localFiles.forEach(file => localFileMap.set(file.path, file));

            const driveFileMap = new Map<string, any>();
            driveFiles.forEach(file => driveFileMap.set(file.path, file));

            // 4. 모든 파일 경로 수집
            const allPaths = new Set([...localFileMap.keys(), ...driveFileMap.keys()]);

            // 5. 각 파일에 대해 동기화 결정
            for (const filePath of allPaths) {
                const localFile = localFileMap.get(filePath);
                const driveFile = driveFileMap.get(filePath);

                try {
                    if (localFile && driveFile) {
                        // 양쪽에 존재: 충돌 해결 필요
                        await this.resolveFileConflict(localFile, driveFile, driveFolder.id, result);
                    } else if (localFile && !driveFile) {
                        // 로컬에만 존재: 업로드
                        await this.uploadSingleFile(localFile, driveFolder.id, result);
                    } else if (!localFile && driveFile) {
                        // 원격에만 존재: 다운로드
                        await this.downloadFileFromDrive(driveFile, result);
                    }
                } catch (error) {
                    console.error(`Error syncing file ${filePath}:`, error);
                    result.errors++;
                }
            }

            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();

        } catch (error) {
            console.error('Bidirectional sync error:', error);
            result.errors++;
        }

        return result;
    }

    // Google Drive에서 파일 다운로드
    private async downloadFileFromDrive(driveFile: any, result: SyncResult): Promise<void> {
        try {
            const filePath = driveFile.path;
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

            // 파일 시간 동기화 - 다운로드/생성 후 원격지 시간으로 설정
            await this.syncFileTime(filePath, remoteModTime);

            result.downloaded++;

        } catch (error) {
            console.error(`Error downloading file ${driveFile.path}:`, error);
            throw error;
        }
    }

    // 파일 시간 동기화 메서드 - 대안 방법들 포함
    private async syncFileTime(filePath: string, targetTime: number): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            
            // 방법 1: Node.js 환경(데스크톱)에서 직접 파일시스템 접근
            if (adapter.constructor.name === 'FileSystemAdapter') {
                try {
                    // @ts-ignore - Node.js FileSystemAdapter 전용
                    const fs = require('fs').promises;
                    // @ts-ignore - Node.js path 모듈
                    const path = require('path');
                    // @ts-ignore - basePath 접근
                    const fullPath = path.join(adapter.basePath, filePath);
                    
                    // 파일 시간을 원격지 시간으로 설정
                    const targetDate = new Date(targetTime);
                    await fs.utimes(fullPath, targetDate, targetDate);
                    
                    console.log(`⏰ Synced file time: ${filePath} -> ${targetDate.toLocaleString()}`);
                    return; // 성공하면 여기서 종료
                } catch (fsError) {
                    console.warn(`⚠️ Direct filesystem access failed: ${fsError}`);
                    // 방법 2로 fallback
                }
            }
            
            // 방법 2: Obsidian API를 통한 우회 방법 (완벽하지 않지만 차선책)
            try {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    // 파일의 내부 상태를 수정하여 시간 정보 업데이트 시도
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
            
            // 방법 3: 메타데이터 파일로 시간 정보 저장 (최후의 수단)
            try {
                const timeMetadata = {
                    originalPath: filePath,
                    remoteModifiedTime: targetTime,
                    syncedAt: Date.now()
                };
                
                // 숨김 메타데이터 파일에 시간 정보 저장
                const metadataPath = `.obsidian/plugins/gdrive-sync/time-metadata/${filePath.replace(/[\/\\]/g, '_')}.json`;
                const metadataDir = metadataPath.substring(0, metadataPath.lastIndexOf('/'));
                
                // 메타데이터 디렉토리 생성
                try {
                    await this.app.vault.createFolder(metadataDir);
                } catch (e) {
                    // 이미 존재하는 경우 무시
                }
                
                await this.app.vault.create(metadataPath, JSON.stringify(timeMetadata, null, 2));
                console.log(`⏰ Stored time metadata: ${filePath} -> ${new Date(targetTime).toLocaleString()}`);
            } catch (metadataError) {
                console.warn(`⚠️ Metadata time storage failed: ${metadataError}`);
            }
            
        } catch (error) {
            // 시간 동기화 실패는 치명적이지 않으므로 경고만 출력
            console.warn(`⚠️ All file time sync methods failed for ${filePath}:`, error);
        }
    }    

    // 메타데이터에서 시간 정보를 읽어오는 헬퍼 메서드
    private async getStoredFileTime(filePath: string): Promise<number | null> {
        try {
            const metadataPath = `.obsidian/plugins/gdrive-sync/time-metadata/${filePath.replace(/[\/\\]/g, '_')}.json`;
            const metadataFile = this.app.vault.getAbstractFileByPath(metadataPath);
            
            if (metadataFile instanceof TFile) {
                const content = await this.app.vault.read(metadataFile);
                const metadata = JSON.parse(content);
                return metadata.remoteModifiedTime || null;
            }
        } catch (error) {
            // 메타데이터가 없는 경우는 정상
        }
        return null;
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
                // 사용자에게 묻기 (현재는 newer로 대체)
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
    private async uploadSingleFile(file: TFile, rootFolderId: string, result: SyncResult): Promise<void> {
        try {
            const syncResult = await this.syncFileToGoogleDrive(file, rootFolderId);
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

    // Google Drive에서 모든 파일 가져오기 (재귀적으로 폴더 구조 포함) - public으로 변경
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
                
                // 메타데이터에 저장된 원격 시간도 확인
                const storedRemoteTime = await this.getStoredFileTime(localFile.path);
                if (storedRemoteTime && storedRemoteTime === driveModTime) {
                    // 이미 동기화된 파일
                    return false;
                }
                
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

        // 생성된 폴더 로그
        if (result.createdFolders.length > 0) {
            console.log('Created folders:', result.createdFolders);
        }
    }

    // 기존 메서드들 (syncVault, syncFolder 등은 새로운 구조에 맞게 수정)
    async syncVault() {
        return await this.syncWithGoogleDrive();
    }

    async syncFolder(folder: TFolder) {
        // 임시로 설정을 변경하여 특정 폴더만 동기화
        const originalSyncWholeVault = this.settings.syncWholeVault;
        const originalSyncFolders = [...this.settings.syncFolders];
        
        this.settings.syncWholeVault = false;
        this.settings.syncFolders = [folder.path];
        
        try {
            const result = await this.syncWithGoogleDrive();
            return result;
        } finally {
            // 설정 복원
            this.settings.syncWholeVault = originalSyncWholeVault;
            this.settings.syncFolders = originalSyncFolders;
        }
    }

    // 파일 수집 메서드 (기존과 동일)
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

    getAllFolders(): TFolder[] {
        const folders: TFolder[] = [];
        
        const rootFolder = this.app.vault.getRoot();
        folders.push(rootFolder);
        
        const allFolders = this.app.vault.getAllLoadedFiles()
            .filter(file => file instanceof TFolder) as TFolder[];
        
        folders.push(...allFolders);
        
        return folders.sort((a, b) => a.path.localeCompare(b.path));
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

    // Google Drive 관련 메서드들 - public으로 변경하여 설정 탭에서 접근 가능
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

    private async syncFileToGoogleDrive(file: TFile, rootFolderId: string): Promise<boolean | 'skipped'> {
        try {
            let relativePath = file.path;
            let fileName = file.name;
            
            let targetFolderId = rootFolderId;
            
            if (relativePath.includes('/')) {
                const pathParts = relativePath.split('/');
                fileName = pathParts.pop()!;
                const folderPath = pathParts.join('/');
                
                console.log(`Creating full folder structure: ${folderPath}`);
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
            const localModTime = file.stat.mtime; // 로컬 파일의 수정 시간

            
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

    private async uploadFileToDrive(fileName: string, content: string, folderId: string, localModTime?: number): Promise<boolean>   {     
        try {
            const metadata = {
                name: fileName,
                parents: [folderId],
                // 로컬 파일의 수정 시간을 Google Drive에도 반영
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

        containerEl.createEl('h2', { text: 'Google Drive Bidirectional Sync Settings' });

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

        // Sync Configuration
        containerEl.createEl('h3', { text: 'Sync Configuration' });

        new Setting(containerEl)
            .setName('Google Drive Folder')
            .setDesc('Name of the folder to create/use in Google Drive')
            .addText(text => text
                .setPlaceholder('e.g., Obsidian-Sync')
                .setValue(this.plugin.settings.driveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.driveFolder = value;
                    await this.plugin.saveSettings();
                }));

        // 동기화 방향 설정 추가
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

        // 충돌 해결 방식 설정 추가
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

        // 누락된 폴더 자동 생성 설정 추가
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
            .setDesc('Enable to sync the entire vault instead of selected folders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncWholeVault)
                .onChange(async (value) => {
                    this.plugin.settings.syncWholeVault = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh the settings display
                }));

        // Sync Folders Section (only show when not syncing whole vault)
        if (!this.plugin.settings.syncWholeVault) {
            const syncFoldersSection = containerEl.createEl('div', { cls: 'sync-folders-section' });
            syncFoldersSection.createEl('h4', { text: 'Sync Folders' });

            // Current sync folders display
            const currentFoldersEl = syncFoldersSection.createEl('div', { cls: 'current-folders' });
            this.updateCurrentFoldersDisplay(currentFoldersEl);

            // Add folder button
            new Setting(syncFoldersSection)
                .setName('Add Sync Folder')
                .setDesc('Select folders to sync with Google Drive')
                .addButton(button => button
                    .setButtonText('Select Folder')
                    .setCta()
                    .onClick(() => {
                        this.openFolderSelector();
                    }));

            // Clear all folders button
            new Setting(syncFoldersSection)
                .setName('Clear All Folders')
                .setDesc('Remove all selected sync folders')
                .addButton(button => button
                    .setButtonText('Clear All')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.syncFolders = [];
                        await this.plugin.saveSettings();
                        this.updateCurrentFoldersDisplay(currentFoldersEl);
                        new Notice('All sync folders cleared');
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
                        // 성공하면 입력 필드 초기화
                        if (textInput) textInput.value = '';
                        
                        // API 테스트 실행
                        setTimeout(async () => {
                            await this.plugin.testDriveAPIConnection();
                        }, 1000);
                    }
                }));

        // Sync Actions - 새로운 양방향 동기화 옵션들 추가
        containerEl.createEl('h3', { text: 'Sync Actions' });

        new Setting(containerEl)
            .setName('Full Bidirectional Sync')
            .setDesc('Perform complete bidirectional synchronization (upload new/changed local files, download new/changed remote files)')
            .addButton(button => button
                .setButtonText('🔄 Sync Both Ways')
                .setCta()
                .onClick(async () => {
                    const originalDirection = this.plugin.settings.syncDirection;
                    this.plugin.settings.syncDirection = 'bidirectional';
                    
                    try {
                        await this.plugin.syncWithGoogleDrive();
                    } finally {
                        this.plugin.settings.syncDirection = originalDirection;
                    }
                }));

        new Setting(containerEl)
            .setName('Upload to Google Drive')
            .setDesc('Upload only: Send local files to Google Drive (one-way sync)')
            .addButton(button => button
                .setButtonText('📤 Upload Only')
                .onClick(async () => {
                    const originalDirection = this.plugin.settings.syncDirection;
                    this.plugin.settings.syncDirection = 'upload';
                    
                    try {
                        await this.plugin.syncWithGoogleDrive();
                    } finally {
                        this.plugin.settings.syncDirection = originalDirection;
                    }
                }));

        new Setting(containerEl)
            .setName('Download from Google Drive')
            .setDesc('Download only: Get files from Google Drive to local vault (one-way sync)')
            .addButton(button => button
                .setButtonText('📥 Download Only')
                .onClick(async () => {
                    const originalDirection = this.plugin.settings.syncDirection;
                    this.plugin.settings.syncDirection = 'download';
                    
                    try {
                        await this.plugin.syncWithGoogleDrive();
                    } finally {
                        this.plugin.settings.syncDirection = originalDirection;
                    }
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
            .setName('Debug Token')
            .setDesc('Show current token status and validity')
            .addButton(button => button
                .setButtonText('Debug')
                .onClick(async () => {
                    if (!this.plugin.settings.accessToken) {
                        new Notice('❌ No access token stored');
                        return;
                    }
                    
                    console.log('=== TOKEN DEBUG INFO ===');
                    console.log('Token exists:', !!this.plugin.settings.accessToken);
                    console.log('Token length:', this.plugin.settings.accessToken.length);
                    console.log('Token preview:', this.plugin.settings.accessToken.substring(0, 20) + '...');
                    
                    const tokenParts = this.plugin.settings.accessToken.split('.');
                    console.log('Token format:', tokenParts.length === 3 ? 'JWT' : 'Bearer');
                    
                    new Notice(`Token info logged to console. Length: ${this.plugin.settings.accessToken.length}`);
                }));

        new Setting(containerEl)
            .setName('Manual Token Input')
            .setDesc('Manually enter access token for testing (temporary solution)')
            .addText(text => text
                .setPlaceholder('Paste access token here...')
                .setValue('')
                .onChange(async (value) => {
                    // 임시로 토큰 저장하지 않고 테스트만 수행
                }))
            .addButton(button => button
                .setButtonText('Test Token')
                .onClick(async (evt) => {
                    const textInput = containerEl.querySelector('input[placeholder="Paste access token here..."]') as HTMLInputElement;
                    const tempToken = textInput?.value?.trim();
                    
                    if (!tempToken) {
                        new Notice('❌ Please enter a token first');
                        return;
                    }
                    
                    const originalToken = this.plugin.settings.accessToken;
                    this.plugin.settings.accessToken = tempToken;
                    
                    console.log('Testing with manual token...');
                    const testResult = await this.plugin.testDriveAPIConnection();
                    
                    if (testResult) {
                        new Notice('✅ Manual token works! You can save it.');
                        const saveToken = confirm('Token works! Do you want to save it to settings?');
                        if (saveToken) {
                            await this.plugin.saveSettings();
                            new Notice('Token saved to settings.');
                        } else {
                            this.plugin.settings.accessToken = originalToken;
                        }
                    } else {
                        this.plugin.settings.accessToken = originalToken;
                        new Notice('❌ Manual token test failed.');
                    }
                    
                    if (textInput) textInput.value = '';
                }));

        new Setting(containerEl)
            .setName('Reset API State')
            .setDesc('Reset Google API state if you encounter issues')
            .addButton(button => button
                .setButtonText('Reset')
                .setWarning()
                .onClick(() => {
                    this.plugin.resetGoogleAPIState();
                    new Notice('Google API state reset. You may need to re-authenticate.');
                }));

        new Setting(containerEl)
            .setName('Sign Out')
            .setDesc('Revoke Google Drive access and sign out')
            .addButton(button => button
                .setButtonText('Sign Out')
                .setWarning()
                .onClick(async () => {
                    await this.plugin.revokeGoogleDriveAccess();
                }));

        // Authentication Status
        containerEl.createEl('h3', { text: 'Authentication Status' });
        const statusEl = containerEl.createEl('div');

        const updateStatus = () => {
            const isAuth = this.plugin.isAuthenticated();
            
            statusEl.innerHTML = `
                <div style="padding: 10px; border-radius: 4px; margin-bottom: 10px; ${isAuth ? 
                    'background-color: #d4edda; border: 1px solid #c3e6cb; color: #155724;' : 
                    'background-color: #f8d7da; border: 1px solid #f5c6cb; color: #721c24;'}">
                    <strong>Authentication:</strong> ${isAuth ? '✅ Authenticated' : '❌ Not Authenticated'}
                    ${this.plugin.settings.accessToken ? 
                        '<br><small>Access token is stored</small>' : 
                        '<br><small>No access token stored</small>'}
                </div>
                <div style="padding: 10px; border-radius: 4px; background-color: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460;">
                    <strong>Mode:</strong> ✅ Desktop Application (Bidirectional Sync)
                    <br><small>Supports upload, download, and bidirectional synchronization with preserved folder structure</small>
                    <br><small>Sync Direction: ${this.plugin.settings.syncDirection === 'bidirectional' ? '🔄 Bidirectional' : 
                        this.plugin.settings.syncDirection === 'upload' ? '📤 Upload Only' : '📥 Download Only'}</small>
                    <br><small>Conflict Resolution: ${this.plugin.settings.conflictResolution === 'newer' ? '🕒 Use Newer File' :
                        this.plugin.settings.conflictResolution === 'local' ? '📱 Always Use Local' :
                        this.plugin.settings.conflictResolution === 'remote' ? '☁️ Always Use Remote' : '❓ Ask User'}</small>
                </div>
            `;
        };

        updateStatus();

        const originalSaveSettings = this.plugin.saveSettings.bind(this.plugin);
        this.plugin.saveSettings = async () => {
            await originalSaveSettings();
            updateStatus();
        };

        // Setup Instructions - 양방향 동기화에 대한 설명 추가
        containerEl.createEl('h3', { text: 'Setup Instructions' });
        const instructionsEl = containerEl.createEl('div');
        instructionsEl.innerHTML = `
            <div style="background-color: #d4edda; border: 1px solid #c3e6cb; padding: 10px; margin: 10px 0; border-radius: 4px;">
                <p><strong>✅ Google Cloud Console 설정 (Desktop Application):</strong></p>
                <ol>
                    <li><a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console - Credentials</a> 접속</li>
                    <li>"Create Credentials" → "OAuth client ID" 선택</li>
                    <li><strong>Application type: "Desktop application"</strong> 선택 (중요!)</li>
                    <li>Name 입력 후 "Create" 클릭</li>
                    <li>생성된 <strong>Client ID</strong>와 <strong>Client Secret</strong>을 위 설정에 입력</li>
                    <li>Google Drive API가 활성화되어 있는지 확인</li>
                </ol>
            </div>
            <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 10px; margin: 10px 0; border-radius: 4px;">
                <p><strong>🔄 양방향 동기화 기능:</strong></p>
                <ul>
                    <li><strong>📤 업로드 전용:</strong> 로컬 파일을 Google Drive에만 업로드</li>
                    <li><strong>📥 다운로드 전용:</strong> Google Drive 파일을 로컬에만 다운로드</li>
                    <li><strong>🔄 양방향 동기화:</strong> 양쪽 모두 확인하고 최신 상태로 동기화</li>
                </ul>
                <p><strong>🤝 충돌 해결 방식:</strong></p>
                <ul>
                    <li><strong>Use Newer File:</strong> 수정 시간이 더 최신인 파일 사용 (권장)</li>
                    <li><strong>Always Use Local:</strong> 항상 로컬 파일 우선</li>
                    <li><strong>Always Use Remote:</strong> 항상 원격 파일 우선</li>
                    <li><strong>Ask User:</strong> 사용자에게 직접 확인 (현재는 newer로 동작)</li>
                </ul>
                <p><strong>📁 자동 폴더 생성:</strong></p>
                <ul>
                    <li>Google Drive에서 다운로드 시 로컬에 없는 폴더 자동 생성</li>
                    <li>폴더 구조를 완전히 보존하여 동기화</li>
                    <li>초기 설정 시 Google Drive의 전체 구조를 로컬로 복제 가능</li>
                </ul>
            </div>
            <div style="background-color: #e7f3ff; border: 1px solid #b3d7ff; padding: 10px; margin: 10px 0; border-radius: 4px;">
                <p><strong>🚀 사용 시나리오:</strong></p>
                <ul>
                    <li><strong>초기 설정:</strong> "📥 Download Only"로 Google Drive 내용을 로컬에 복제</li>
                    <li><strong>일상 작업:</strong> "🔄 Sync Both Ways"로 양방향 동기화</li>
                    <li><strong>백업:</strong> "📤 Upload Only"로 로컬 변경사항만 업로드</li>
                    <li><strong>복원:</strong> "📥 Download Only"로 Google Drive에서 복원</li>
                </ul>
                <p><strong>💡 팁:</strong></p>
                <ul>
                    <li>먼저 "Preview Sync"로 동기화될 파일 확인</li>
                    <li>"Create Missing Folders" 옵션으로 폴더 구조 자동 생성</li>
                    <li>Auto Sync 기능으로 정기적 자동 동기화</li>
                </ul>
            </div>
        `;
    }

    // 현재 선택된 폴더들 표시 업데이트
    private updateCurrentFoldersDisplay(containerEl: HTMLElement) {
        containerEl.empty();
        
        if (this.plugin.settings.syncFolders.length === 0) {
            containerEl.createEl('p', { text: 'No folders selected for sync', cls: 'setting-item-description' });
            return;
        }

        containerEl.createEl('p', { text: 'Selected folders:', cls: 'setting-item-description' });
        
        const folderList = containerEl.createEl('div', { cls: 'sync-folders-list' });
        
        this.plugin.settings.syncFolders.forEach((folderPath, index) => {
            const folderItem = folderList.createEl('div', { 
                cls: 'sync-folder-item',
                attr: { style: 'display: flex; align-items: center; margin-bottom: 5px; padding: 5px; background-color: var(--background-secondary); border-radius: 3px;' }
            });
            
            const folderName = folderItem.createEl('span', { 
                text: folderPath || '📁 Vault Root',
                attr: { style: 'flex-grow: 1; margin-right: 10px;' }
            });
            
            const removeButton = folderItem.createEl('button', { 
                text: '✖',
                cls: 'mod-warning',
                attr: { style: 'min-width: 24px; height: 24px; padding: 0; border-radius: 3px;' }
            });
            
            removeButton.onclick = async () => {
                this.plugin.settings.syncFolders.splice(index, 1);
                await this.plugin.saveSettings();
                this.updateCurrentFoldersDisplay(containerEl);
                new Notice(`Removed folder: ${folderPath || 'Vault Root'}`);
            };
        });
    }

    // 폴더 선택 모달 열기
    private openFolderSelector() {
        const modal = new FolderTreeModal(this.app, this.plugin, async (selectedFolder) => {
            const folderPath = selectedFolder.path;
            
            if (this.plugin.settings.syncFolders.includes(folderPath)) {
                new Notice(`Folder "${folderPath || 'Vault Root'}" is already selected`);
                return;
            }
            
            this.plugin.settings.syncFolders.push(folderPath);
            await this.plugin.saveSettings();
            
            const currentFoldersEl = document.querySelector('.current-folders') as HTMLElement;
            if (currentFoldersEl) {
                this.updateCurrentFoldersDisplay(currentFoldersEl);
            }
            
            new Notice(`Added folder: ${folderPath || 'Vault Root'}`);
        });
        
        modal.open();
    }

    // 동기화 미리보기 - 양방향 지원 버전
    private async previewSync() {
        if (!this.plugin.isAuthenticated()) {
            new Notice('❌ Please authenticate first');
            return;
        }

        try {
            console.log('=== BIDIRECTIONAL SYNC PREVIEW ===');
            console.log(`Google Drive folder: ${this.plugin.settings.driveFolder}`);
            console.log(`Sync direction: ${this.plugin.settings.syncDirection}`);
            console.log(`Conflict resolution: ${this.plugin.settings.conflictResolution}`);
            console.log(`Include subfolders: ${this.plugin.settings.includeSubfolders}`);
            console.log(`Create missing folders: ${this.plugin.settings.createMissingFolders}`);
            console.log(`Last sync: ${this.plugin.settings.lastSyncTime ? new Date(this.plugin.settings.lastSyncTime).toLocaleString() : 'Never'}`);

            // 로컬 파일 수집
            let localFiles: TFile[] = [];
            if (this.plugin.settings.syncWholeVault) {
                const allFiles = this.plugin.app.vault.getFiles();
                localFiles = allFiles.filter(file => this.plugin.shouldSyncFileType(file));
                console.log(`\n📱 LOCAL FILES (Whole Vault): ${localFiles.length} files`);
            } else {
                if (this.plugin.settings.syncFolders.length === 0) {
                    new Notice('❌ No folders selected for sync');
                    return;
                }

                console.log(`\n📱 LOCAL FILES (Selected Folders):`);
                for (const folderPath of this.plugin.settings.syncFolders) {
                    const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
                    if (folder && folder instanceof TFolder) {
                        const files = await this.plugin.collectFilesToSync(folder, this.plugin.settings.includeSubfolders);
                        localFiles.push(...files);
                        console.log(`  📁 ${folderPath || 'Vault Root'}: ${files.length} files`);
                    }
                }
            }

            localFiles.forEach(file => {
                const modTime = new Date(file.stat.mtime).toLocaleString();
                console.log(`    - ${file.path} (modified: ${modTime})`);
            });

            // Google Drive 파일 수집
            const driveFolder = await this.plugin.getOrCreateDriveFolder();
            if (!driveFolder) {
                new Notice('❌ Failed to access Google Drive folder');
                return;
            }

            const driveFiles = await this.plugin.getAllFilesFromDrive(driveFolder.id);
            console.log(`\n☁️ GOOGLE DRIVE FILES: ${driveFiles.length} files`);
            driveFiles.forEach(file => {
                const modTime = new Date(file.modifiedTime).toLocaleString();
                console.log(`    - ${file.path} (modified: ${modTime})`);
            });

            // 동기화 분석
            const localFileMap = new Map<string, TFile>();
            localFiles.forEach(file => localFileMap.set(file.path, file));

            const driveFileMap = new Map<string, any>();
            driveFiles.forEach(file => driveFileMap.set(file.path, file));

            const allPaths = new Set([...localFileMap.keys(), ...driveFileMap.keys()]);

            let toUpload = 0;
            let toDownload = 0;
            let conflicts = 0;
            let skipped = 0;

            console.log(`\n🔍 SYNC ANALYSIS:`);
            for (const filePath of allPaths) {
                const localFile = localFileMap.get(filePath);
                const driveFile = driveFileMap.get(filePath);

                if (localFile && driveFile) {
                    // 충돌 가능성
                    const localModTime = localFile.stat.mtime;
                    const driveModTime = new Date(driveFile.modifiedTime).getTime();
                    
                    if (this.plugin.settings.syncDirection === 'bidirectional') {
                        if (localModTime !== driveModTime) {
                            conflicts++;
                            console.log(`  ⚠️ CONFLICT: ${filePath} (local: ${new Date(localModTime).toLocaleString()}, remote: ${new Date(driveModTime).toLocaleString()})`);
                        } else {
                            skipped++;
                            console.log(`  ⏭️ SKIP: ${filePath} (same modification time)`);
                        }
                    } else if (this.plugin.settings.syncDirection === 'upload') {
                        if (localModTime > driveModTime) {
                            toUpload++;
                            console.log(`  📤 UPLOAD: ${filePath}`);
                        } else {
                            skipped++;
                            console.log(`  ⏭️ SKIP: ${filePath} (remote is newer or same)`);
                        }
                    } else if (this.plugin.settings.syncDirection === 'download') {
                        if (driveModTime > localModTime) {
                            toDownload++;
                            console.log(`  📥 DOWNLOAD: ${filePath}`);
                        } else {
                            skipped++;
                            console.log(`  ⏭️ SKIP: ${filePath} (local is newer or same)`);
                        }
                    }
                } else if (localFile && !driveFile) {
                    if (this.plugin.settings.syncDirection !== 'download') {
                        toUpload++;
                        console.log(`  📤 UPLOAD NEW: ${filePath}`);
                    } else {
                        skipped++;
                        console.log(`  ⏭️ SKIP: ${filePath} (local only, download mode)`);
                    }
                } else if (!localFile && driveFile) {
                    if (this.plugin.settings.syncDirection !== 'upload') {
                        toDownload++;
                        console.log(`  📥 DOWNLOAD NEW: ${filePath}`);
                    } else {
                        skipped++;
                        console.log(`  ⏭️ SKIP: ${filePath} (remote only, upload mode)`);
                    }
                }
            }

            const summary = [
                `📤 To Upload: ${toUpload}`,
                `📥 To Download: ${toDownload}`,
                `⚠️ Conflicts: ${conflicts}`,
                `⏭️ Skipped: ${skipped}`,
                `📁 Total Files: ${allPaths.size}`
            ].join(', ');

            console.log(`\n📋 SUMMARY: ${summary}`);
            new Notice(`📋 Sync Preview: ${summary}. Check console for details.`);

        } catch (error) {
            console.error('Preview sync error:', error);
            new Notice('❌ Failed to preview sync. Check console for details.');
        }
    }
}