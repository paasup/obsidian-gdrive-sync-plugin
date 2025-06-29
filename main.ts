import { App, Plugin, PluginSettingTab, Setting, Notice, TFolder, TFile, requestUrl } from 'obsidian';

interface GDriveSyncSettings {
    clientId: string;
    clientSecret: string;
    apiKey: string;
    syncFolder: string;
    autoSync: boolean;
    syncInterval: number;
    accessToken: string;
    driveFolder: string; // Google Drive 폴더 이름
    includeSubfolders: boolean; // 하위 폴더 포함 여부
    syncMode: 'always' | 'modified' | 'checksum'; // 동기화 모드
    lastSyncTime: number; // 마지막 동기화 시간
}

const DEFAULT_SETTINGS: GDriveSyncSettings = {
    clientId: '',
    clientSecret: '',
    apiKey: '',
    syncFolder: '',
    autoSync: false,
    syncInterval: 300000, // 5 minutes
    accessToken: '',
    driveFolder: 'Obsidian-Sync', // 기본 Google Drive 폴더명
    includeSubfolders: true, // 기본적으로 하위 폴더 포함
    syncMode: 'modified', // 기본: 수정 시간 기반
    lastSyncTime: 0
};

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

        this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

        console.log('Plugin loaded - Desktop App authentication mode with folder structure preservation');

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
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async authenticateGoogleDrive(): Promise<boolean> {
        console.log('=== Starting Google Drive Desktop Authentication ===');
        
        // 설정 확인
        if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.apiKey) {
            console.error('Missing credentials');
            new Notice('❌ Please set Client ID, Client Secret, and API Key in settings first.');
            return false;
        }

        console.log('✓ Credentials are set');

        // Desktop Application용 인증 URL 생성
        const authUrl = this.generateAuthUrl();
        
        new Notice('Opening browser for Desktop App authentication...');
        console.log('Desktop Auth URL:', authUrl);
        
        // 브라우저에서 URL 열기
        try {
            window.open(authUrl, '_blank');
            
            new Notice('🔗 Complete authentication in browser, then copy the authorization code and use "Authorization Code" input in settings.');
            
            return false; // 수동 프로세스이므로 false 반환
        } catch (error) {
            console.error('Failed to open browser:', error);
            
            // URL을 클립보드에 복사
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
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', // Desktop app용 out-of-band
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

            // 로컬 토큰 제거
            this.settings.accessToken = '';
            await this.saveSettings();

            console.log('✓ Google Drive access revoked successfully');
            new Notice('Google Drive access revoked successfully');
            return true;

        } catch (error) {
            console.error('Failed to revoke access:', error);
            new Notice('Failed to revoke access. Token cleared locally.');
            
            // 오류가 발생해도 로컬 토큰은 제거
            this.settings.accessToken = '';
            await this.saveSettings();
            return false;
        }
    }

    isAuthenticated(): boolean {
        return !!(this.settings.accessToken);
    }

    async syncWithGoogleDrive() {
        if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.apiKey) {
            new Notice('Please configure Google Drive API credentials in settings');
            return;
        }

        if (!this.settings.syncFolder) {
            new Notice('Please select a folder to sync in settings');
            return;
        }

        new Notice('Starting Google Drive sync...');

        try {
            if (!this.isAuthenticated()) {
                new Notice('Please authenticate first using the Desktop App method.');
                return;
            }

            const folder = this.app.vault.getAbstractFileByPath(this.settings.syncFolder);
            if (!folder || !(folder instanceof TFolder)) {
                new Notice('Sync folder not found');
                return;
            }

            await this.syncFolder(folder);
            new Notice('Google Drive sync completed');

        } catch (error) {
            console.error('Sync failed:', error);
            new Notice('Google Drive sync failed');
        }
    }

    async syncFolder(folder: TFolder) {
        console.log(`Syncing folder: ${folder.path}`);
        console.log(`Include subfolders: ${this.settings.includeSubfolders}`);
        
        try {
            // Google Drive에서 Obsidian 동기화 폴더 찾기 또는 생성
            const driveFolder = await this.getOrCreateDriveFolder();
            if (!driveFolder) {
                new Notice('❌ Failed to create or find Google Drive folder');
                return;
            }

            console.log(`✓ Google Drive folder ready: ${this.settings.driveFolder}`);

            // 로컬 파일 수집
            const filesToSync = await this.collectFilesToSyncPrivate(folder, this.settings.includeSubfolders);
            console.log(`Found ${filesToSync.length} files to sync`);

            if (filesToSync.length === 0) {
                new Notice('No files found to sync');
                return;
            }

            // 파일 동기화 시작
            let successCount = 0;
            let errorCount = 0;
            let skippedCount = 0;

            for (const file of filesToSync) {
                try {
                    const result = await this.syncFileToGoogleDrive(file, driveFolder.id);
                    if (result === 'skipped') {
                        skippedCount++;
                    } else if (result === true) {
                        successCount++;
                    } else {
                        errorCount++;
                        console.error(`✗ Failed to sync: ${file.path}`);
                    }
                } catch (error) {
                    errorCount++;
                    console.error(`✗ Error syncing ${file.path}:`, error);
                }

                // UI 업데이트를 위한 작은 지연
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // 동기화 시간 업데이트
            this.settings.lastSyncTime = Date.now();
            await this.saveSettings();

            // 결과 보고
            if (errorCount === 0) {
                new Notice(`✅ Sync completed: ${successCount} synced, ${skippedCount} skipped`);
            } else {
                new Notice(`⚠️ Sync completed with errors: ${successCount} synced, ${skippedCount} skipped, ${errorCount} errors`);
            }

        } catch (error) {
            console.error('Sync folder error:', error);
            new Notice('❌ Sync failed. Check console for details.');
        }
    }

    // Public method for settings tab
    async collectFilesToSync(folder: TFolder, includeSubfolders: boolean): Promise<TFile[]> {
        const files: TFile[] = [];

        // 현재 폴더의 파일들 수집
        for (const child of folder.children) {
            if (child instanceof TFile) {
                // 특정 파일 타입만 동기화 (예: .md, .txt, .json 등)
                if (this.shouldSyncFileType(child)) {
                    files.push(child);
                }
            } else if (child instanceof TFolder && includeSubfolders) {
                // 하위 폴더 재귀적으로 처리
                const subfolderFiles = await this.collectFilesToSync(child, true);
                files.push(...subfolderFiles);
            }
        }

        return files;
    }

    // 동기화할 파일들을 수집 (하위 폴더 포함/제외 옵션)
    private async collectFilesToSyncPrivate(folder: TFolder, includeSubfolders: boolean): Promise<TFile[]> {
        return this.collectFilesToSync(folder, includeSubfolders);
    }

    // 파일이 동기화 대상인지 확인
    private shouldSyncFileType(file: TFile): boolean {
        // 동기화할 파일 확장자 목록
        const syncExtensions = ['.md', '.txt', '.json', '.csv', '.html', '.css', '.js'];
        
        // 제외할 파일들
        const excludePatterns = [
            /^\./, // 숨김 파일
            /\.tmp$/, // 임시 파일
            /\.bak$/, // 백업 파일
            /\.lock$/, // 락 파일
        ];

        // 확장자 확인
        const hasValidExtension = syncExtensions.some(ext => file.name.endsWith(ext));
        
        // 제외 패턴 확인
        const shouldExclude = excludePatterns.some(pattern => pattern.test(file.name));

        return hasValidExtension && !shouldExclude;
    }

    // Google Drive에서 Obsidian 동기화 폴더 찾기 또는 생성
    private async getOrCreateDriveFolder(): Promise<{id: string, name: string} | null> {
        try {
            console.log(`Looking for Google Drive folder: ${this.settings.driveFolder}`);

            // 기존 폴더 검색
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
                    // 기존 폴더 발견
                    const folder = searchData.files[0];
                    console.log(`✓ Found existing folder: ${folder.name} (${folder.id})`);
                    return { id: folder.id, name: folder.name };
                }
            }

            // 폴더가 없으면 새로 생성
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

    // 개별 파일을 Google Drive에 동기화
    private async syncFileToGoogleDrive(file: TFile, rootFolderId: string): Promise<boolean | 'skipped'> {
        try {
            // 파일의 상대 경로 계산
            const relativePath = file.path.replace(this.settings.syncFolder + '/', '');
            
            // 실제 폴더 구조 생성
            let targetFolderId = rootFolderId;
            let fileName = file.name;
            
            if (relativePath.includes('/')) {
                // 중첩된 폴더 생성
                const pathParts = relativePath.split('/');
                fileName = pathParts.pop()!; // 마지막이 파일명
                const folderPath = pathParts.join('/');
                
                targetFolderId = await this.createNestedFolders(folderPath, rootFolderId);
                if (!targetFolderId) {
                    console.error(`Failed to create folder structure for: ${folderPath}`);
                    return false;
                }
            }
            
            // Google Drive에서 기존 파일 검색
            const existingFile = await this.findFileInDrive(fileName, targetFolderId);
            
            // 동기화 필요 여부 확인
            const needsSync = await this.shouldSyncFile(file, existingFile);
            
            if (!needsSync) {
                console.log(`⏭️ Skipping ${file.path} (no changes detected)`);
                return 'skipped'; // 건너뛰기는 'skipped' 문자열 반환
            }

            // 파일 내용 읽기
            const content = await this.app.vault.read(file);
            
            if (existingFile) {
                // 기존 파일 업데이트
                console.log(`🔄 Updating ${file.path}`);
                return await this.updateFileInDrive(existingFile.id, content, file.stat.mtime);
            } else {
                // 새 파일 업로드
                console.log(`📤 Uploading ${file.path}`);
                return await this.uploadFileToDrive(fileName, content, targetFolderId);
            }

        } catch (error) {
            console.error(`Error syncing file ${file.path}:`, error);
            return false;
        }
    }

    // 파일 동기화 필요 여부 판단
    private async shouldSyncFile(localFile: TFile, driveFile: any): Promise<boolean> {
        switch (this.settings.syncMode) {
            case 'always':
                // 항상 동기화
                return true;

            case 'modified':
                // 수정 시간 기반 비교
                if (!driveFile) {
                    return true; // 새 파일
                }
                
                const localModTime = localFile.stat.mtime;
                const driveModTime = new Date(driveFile.modifiedTime).getTime();
                
                // 로컬 파일이 더 최근에 수정되었으면 동기화
                return localModTime > driveModTime;

            case 'checksum':
                // 파일 내용 해시 기반 비교
                if (!driveFile) {
                    return true; // 새 파일
                }
                
                try {
                    const localContent = await this.app.vault.read(localFile);
                    const localHash = await this.calculateFileHash(localContent);
                    
                    // Google Drive에서 파일 내용 가져와서 해시 비교
                    const driveContent = await this.getFileContentFromDrive(driveFile.id);
                    const driveHash = await this.calculateFileHash(driveContent);
                    
                    return localHash !== driveHash;
                } catch (error) {
                    console.error('Error comparing file checksums:', error);
                    return true; // 오류 시 안전하게 동기화
                }

            default:
                return true;
        }
    }

    // 파일 해시 계산 (SHA-256)
    private async calculateFileHash(content: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Google Drive에서 파일 내용 가져오기
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
                // ArrayBuffer를 문자열로 변환
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

    // 중첩된 폴더 구조 생성
    private async createNestedFolders(folderPath: string, rootFolderId: string): Promise<string> {
        const pathParts = folderPath.split('/');
        let currentFolderId = rootFolderId;

        for (const folderName of pathParts) {
            if (!folderName) continue; // 빈 문자열 건너뛰기
            
            // 현재 폴더에서 하위 폴더 찾기
            const existingFolder = await this.findFolderInDrive(folderName, currentFolderId);
            
            if (existingFolder) {
                currentFolderId = existingFolder.id;
                console.log(`✓ Found existing folder: ${folderName}`);
            } else {
                // 새 폴더 생성
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

    // Google Drive에서 폴더 검색
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

    // Google Drive에 새 폴더 생성
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

    // Google Drive에서 파일 검색
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

    // Google Drive에 새 파일 업로드
    private async uploadFileToDrive(fileName: string, content: string, folderId: string): Promise<boolean> {
        try {
            const metadata = {
                name: fileName,
                parents: [folderId]
            };

            // Multipart upload를 위한 boundary 생성
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

    // Google Drive의 기존 파일 업데이트
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
            
            // requestUrl 사용하여 CORS 문제 해결
            const response = await requestUrl({
                url: 'https://www.googleapis.com/drive/v3/about?fields=user',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.accessToken}`
                },
                throw: false // 수동 에러 처리
            });

            console.log('API Response Status:', response.status);
            console.log('API Response Headers:', response.headers);

            if (response.status === 200) {
                const data = response.json;
                console.log('Drive API test successful:', data);
                new Notice(`✅ Drive API connection successful. User: ${data.user?.displayName || 'Unknown'}`);
                return true;
            } else if (response.status === 401) {
                console.error('Authentication failed - Token expired or invalid');
                new Notice('❌ Authentication expired. Please sign in again.');
                
                // 만료된 토큰 제거
                this.settings.accessToken = '';
                await this.saveSettings();
                
                // 자동으로 재인증 시도 제안
                new Notice('Click "1. Open Auth URL" again to re-authenticate.');
                return false;
            } else if (response.status === 403) {
                console.error('API access denied - Check API key and permissions');
                try {
                    const errorData = response.json;
                    console.error('Error details:', errorData);
                    
                    if (errorData.error?.message?.includes('API key')) {
                        new Notice('❌ Invalid API Key. Please check your API Key in settings.');
                    } else if (errorData.error?.message?.includes('quota')) {
                        new Notice('❌ API quota exceeded. Try again later.');
                    } else {
                        new Notice('❌ API access denied. Check your API Key and Drive API is enabled.');
                    }
                } catch (parseError) {
                    new Notice('❌ API access denied. Check your API Key and Drive API is enabled.');
                }
                return false;
            } else if (response.status === 400) {
                console.error('Bad request - Check API parameters');
                new Notice('❌ Bad request. Check your API configuration.');
                return false;
            } else {
                console.error(`Drive API test failed: ${response.status}`);
                try {
                    const errorData = response.json;
                    console.error('Error details:', errorData);
                } catch (parseError) {
                    console.error('Could not parse error response');
                }
                new Notice(`❌ Drive API connection failed (Status: ${response.status}). Check console for details.`);
                return false;
            }

        } catch (error) {
            console.error('Drive API test error:', error);
            
            // 네트워크 오류와 다른 오류 구분
            if (error.message?.includes('Network')) {
                new Notice('❌ Network error. Check your internet connection.');
            } else if (error.message?.includes('CORS')) {
                new Notice('❌ CORS error. This should not happen with requestUrl.');
            } else {
                new Notice('❌ Unexpected error occurred. Check console for details.');
            }
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

        containerEl.createEl('h2', { text: 'Google Drive File Sync Settings' });

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
            .setName('Sync Folder')
            .setDesc('Local folder to sync with Google Drive')
            .addText(text => text
                .setPlaceholder('e.g., Documents/Sync')
                .setValue(this.plugin.settings.syncFolder)
                .onChange(async (value) => {
                    this.plugin.settings.syncFolder = value;
                    await this.plugin.saveSettings();
                }));

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

        // Testing & Debugging
        containerEl.createEl('h3', { text: 'Testing & Debugging' });

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
                    
                    // JWT 토큰인지 확인 (일반적으로 Google은 JWT 형식 사용)
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
                    
                    // 임시로 토큰 설정하고 테스트
                    const originalToken = this.plugin.settings.accessToken;
                    this.plugin.settings.accessToken = tempToken;
                    
                    console.log('Testing with manual token...');
                    const testResult = await this.plugin.testDriveAPIConnection();
                    
                    if (testResult) {
                        new Notice('✅ Manual token works! You can save it.');
                        // 성공하면 토큰 저장 옵션 제공
                        const saveToken = confirm('Token works! Do you want to save it to settings?');
                        if (saveToken) {
                            await this.plugin.saveSettings();
                            new Notice('Token saved to settings.');
                        } else {
                            this.plugin.settings.accessToken = originalToken;
                        }
                    } else {
                        // 실패하면 원래 토큰으로 복구
                        this.plugin.settings.accessToken = originalToken;
                        new Notice('❌ Manual token test failed.');
                    }
                    
                    // 입력 필드 초기화
                    if (textInput) textInput.value = '';
                }));

        new Setting(containerEl)
            .setName('Test API Connection')
            .setDesc('Test your current access token with Google Drive API')
            .addButton(button => button
                .setButtonText('Test Connection')
                .onClick(async () => {
                    await this.plugin.testDriveAPIConnection();
                }));

        // Sync Actions
        containerEl.createEl('h3', { text: 'Sync Actions' });

        new Setting(containerEl)
            .setName('Preview Sync')
            .setDesc('Show what files would be synced (without actually syncing)')
            .addButton(button => button
                .setButtonText('Preview')
                .onClick(async () => {
                    if (!this.plugin.settings.syncFolder) {
                        new Notice('❌ Please set a sync folder first');
                        return;
                    }

                    const folder = this.plugin.app.vault.getAbstractFileByPath(this.plugin.settings.syncFolder);
                    if (!folder || !(folder instanceof TFolder)) {
                        new Notice('❌ Sync folder not found');
                        return;
                    }

                    const files = await this.plugin.collectFilesToSync(folder, this.plugin.settings.includeSubfolders);
                    console.log('=== SYNC PREVIEW ===');
                    console.log(`Sync folder: ${this.plugin.settings.syncFolder}`);
                    console.log(`Google Drive folder: ${this.plugin.settings.driveFolder}`);
                    console.log(`Include subfolders: ${this.plugin.settings.includeSubfolders}`);
                    console.log(`Sync mode: ${this.plugin.settings.syncMode}`);
                    console.log(`Last sync: ${this.plugin.settings.lastSyncTime ? new Date(this.plugin.settings.lastSyncTime).toLocaleString() : 'Never'}`);
                    console.log(`Files to sync (${files.length}):`);
                    files.forEach(file => {
                        const modTime = new Date(file.stat.mtime).toLocaleString();
                        console.log(`  - ${file.path} (modified: ${modTime})`);
                    });
                    
                    new Notice(`📋 Found ${files.length} files to sync. Check console for details.`);
                }));

        new Setting(containerEl)
            .setName('Manual Sync')
            .setDesc('Manually trigger sync with Google Drive')
            .addButton(button => button
                .setButtonText('Sync Now')
                .setCta()
                .onClick(async () => {
                    await this.plugin.syncWithGoogleDrive();
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
                    <strong>Mode:</strong> ✅ Desktop Application (Folder Structure Preserved)
                    <br><small>Creates actual folders in Google Drive matching your local structure</small>
                </div>
            `;
        };

        updateStatus();

        // 설정 저장 시 상태 업데이트
        const originalSaveSettings = this.plugin.saveSettings.bind(this.plugin);
        this.plugin.saveSettings = async () => {
            await originalSaveSettings();
            updateStatus();
        };

        // Setup Instructions
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
                <p><strong>장점:</strong> Redirect URI 설정이 필요 없어 더 간단합니다!</p>
                <p><strong>⚠️ 중요:</strong> Desktop Application에서는 Client ID와 Client Secret이 모두 필요합니다.</p>
            </div>
            <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 10px; margin: 10px 0; border-radius: 4px;">
                <p><strong>🔄 Desktop App 인증 방법:</strong></p>
                <ol>
                    <li><strong>"1. Open Auth URL" 클릭</strong> → 브라우저에서 Google 인증 페이지 열림</li>
                    <li><strong>Google 계정으로 로그인</strong> → Drive API 권한 허용</li>
                    <li><strong>Authorization Code 복사</strong> → 브라우저에 표시되는 코드 복사</li>
                    <li><strong>코드 붙여넣기</strong> → "Authorization Code" 입력란에 붙여넣기</li>
                    <li><strong>"2. Exchange for Token" 클릭</strong> → 토큰으로 교환 및 자동 테스트</li>
                </ol>
            </div>
            <div style="background-color: #e7f3ff; border: 1px solid #b3d7ff; padding: 10px; margin: 10px 0; border-radius: 4px;">
                <p><strong>📁 동기화 동작 방식:</strong></p>
                <ul>
                    <li><strong>하위 폴더:</strong> "Include Subfolders" 설정에 따라 재귀적으로 처리됩니다</li>
                    <li><strong>폴더 구조:</strong> Google Drive에 원본과 동일한 실제 폴더 구조를 생성합니다
                        <br>예: <code>62.개인지식/10.최근식/세미나/Team.md</code> → Google Drive에서도 같은 구조
                    </li>
                    <li><strong>파일 타입:</strong> .md, .txt, .json, .csv, .html, .css, .js 파일만 동기화</li>
                    <li><strong>제외 파일:</strong> 숨김 파일(.), 임시 파일(.tmp), 백업 파일(.bak) 제외</li>
                    <li><strong>Google Drive 위치:</strong> 지정한 "Google Drive Folder" 이름으로 루트에 생성</li>
                </ul>
                <p><strong>🔄 동기화 모드:</strong></p>
                <ul>
                    <li><strong>Always sync:</strong> 모든 파일을 항상 업로드 (가장 안전하지만 느림)</li>
                    <li><strong>Modified time:</strong> 로컬 파일이 더 최근에 수정된 경우만 동기화 (권장)</li>
                    <li><strong>Content checksum:</strong> 파일 내용 해시를 비교하여 실제 변경된 경우만 동기화 (가장 정확하지만 느림)</li>
                </ul>
                <p><strong>💡 팁:</strong> "Preview Sync" 버튼으로 동기화 대상 파일을 미리 확인하세요!</p>
            </div>
        `;
    }
}