
## 환경 구성
```
$ node -v
v20.15.1

$ npm install -g typescript
$ npm install -g esbuild
```


## 빌드
```
# 의존성 설치
npm install

# 개발 모드 (파일 변경 감지)
npm run dev

# 또는 프로덕션 빌드
npm run build
```

## 설치
### 수동 설치
```
# Obsidian vault의 .obsidian/plugins 디렉토리로 이동
cd /path/to/your/vault/.obsidian/plugins

# 플러그인 폴더 생성
mkdir gdrive-file-sync
cd gdrive-file-sync

# 빌드된 파일들 복사
cp /path/to/your/plugin/main.js .
cp /path/to/your/plugin/manifest.json .
```
### 심볼릭 링크 (개발단계)
```
# Windows (관리자 권한 필요)
mklink /D "C:\path\to\vault\.obsidian\plugins\gdrive-file-sync" "C:\path\to\your\plugin"

# macOS/Linux
ln -s /path/to/your/plugin /path/to/vault/.obsidian/plugins/gdrive-file-sync
```

## Google Drive API 설정 (Google Identity Services 사용)

이 플러그인은 **Google Identity Services (GIS)**를 사용하여 Google Drive API에 인증합니다. 다음 단계를 따라 설정해야 합니다:

### 🔄 마이그레이션 공지
이 플러그인은 기존의 Google Sign-In JavaScript 라이브러리에서 **Google Identity Services (GIS)**로 마이그레이션되었습니다. 이는 더 나은 보안성과 호환성을 제공합니다.

### 1. Google Cloud Console 설정

1. [Google Cloud Console](https://console.cloud.google.com/)에 접속
2. 새 프로젝트를 생성하거나 기존 프로젝트 선택
3. **API 및 서비스 > 라이브러리**에서 "Google Drive API" 검색 후 활성화

### 2. 인증 정보 생성

#### API 키 생성
1. **API 및 서비스 > 사용자 인증 정보**로 이동
2. **+ 사용자 인증 정보 만들기** 클릭
3. **API 키** 선택
4. 생성된 API 키를 복사해 둡니다

#### OAuth 2.0 클라이언트 ID 생성
1. 같은 페이지에서 **+ 사용자 인증 정보 만들기** 다시 클릭
2. **OAuth 2.0 클라이언트 ID** 선택
3. **애플리케이션 유형**에서 반드시 **웹 애플리케이션** 선택 (중요!)
   - ⚠️ **데스크톱 애플리케이션**을 선택하면 "승인된 JavaScript 원본" 메뉴가 나타나지 않습니다
4. **이름**: 원하는 이름 입력 (예: "Obsidian GDrive Sync")

### 3. 승인된 JavaScript 원본 설정 (Google Identity Services용)

**웹 애플리케이션**으로 생성한 OAuth 2.0 클라이언트 ID 설정에서 **승인된 JavaScript 원본**에 다음 URL들을 추가해야 합니다:

```
http://localhost
https://localhost
http://127.0.0.1
https://127.0.0.1
app://obsidian.md
capacitor://localhost
```

⚠️ **이 단계를 빠뜨리면 "authentication failed" 오류가 발생합니다!**

**Google Identity Services 특징:**
- 더 안전한 토큰 기반 인증
- 팝업 차단에 덜 민감함
- 모바일 환경 지원 개선
- `app://obsidian.md`와 `capacitor://localhost` 지원으로 Obsidian 앱 호환성 향상

### 4. 플러그인 설정

1. Obsidian에서 플러그인 설정 열기
2. Google Cloud Console에서 생성한 **Client ID**와 **API Key** 입력
3. 동기화할 폴더 경로 설정
4. **Test Connection** 버튼으로 연결 테스트

### 문제 해결 (Google Identity Services)

**Obsidian 개발자 콘솔 보는 방법:**
- **Windows/Linux**: `Ctrl + Shift + I` 또는 `F12`
- **macOS**: `Cmd + Option + I`
- 또는 `View` → `Toggle Developer Tools` 메뉴 사용
- 콘솔 탭에서 오류 메시지와 로그 확인 가능

**Google APIs not loaded 오류가 발생하는 경우:**
1. 개발자 콘솔을 열어 구체적인 오류 메시지 확인
2. 플러그인 설정에서 "Initialize Google API" 버튼 클릭
3. 인터넷 연결 상태 확인
4. Client ID와 API Key가 올바르게 입력되었는지 확인
5. 방화벽이나 광고 차단기가 `accounts.google.com`을 차단하지 않는지 확인

