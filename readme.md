# ☁️ Obsidian Google Drive Sync Plugin

Seamlessly synchronize your Obsidian vault or specific folders with Google Drive, ensuring your notes are always backed up and accessible.

## ✨ Features

* **Bidirectional Sync**: Keep your local Obsidian vault and Google Drive files in perfect harmony.
* **One-way Sync**: Choose to either upload your local changes to Google Drive or download changes from Google Drive to your vault.
* **Folder-based Sync**: Sync your entire vault or select specific Google Drive folders to synchronize with corresponding local folders in Obsidian.
* **Automatic Synchronization**: Set a custom interval for the plugin to automatically sync your notes in the background.
* **Manual Sync**: Trigger a sync anytime with a single click from the ribbon icon or command palette.
* **Conflict Resolution**: Configurable options to handle conflicts when both local and remote files have been modified.
* **File Type Filtering**: Currently supports `.md`, `.txt`, `.json`, `.csv`, and `.html` file types.
* **Progress Monitoring**: A dedicated modal shows the real-time progress, logs, and summary of your sync operations.
* **Robust Authentication**: Utilizes Google OAuth 2.0 for secure and long-term access to your Google Drive.
* **Folder Creation**: Automatically creates missing local folders when downloading files from Google Drive.

## 🚀 Getting Started

### 1. Installation

This plugin is not yet available in the Obsidian community plugins. You'll need to install it manually:

1.  Download the latest release from the [releases page](https://github.com/paasup/obsidian-gdrive-sync-plugin/releases).
2.  Unzip the contents into your Obsidian vault's `.obsidian/plugins/` folder.
3.  Reload Obsidian.
4.  Go to `Settings` -> `Community plugins` and enable "Google Drive Sync".

### 2. Google Cloud Project Setup

To use this plugin, you need to create a Google Cloud Project and obtain OAuth 2.0 credentials.

#### **1. Google Cloud Console Setup**
1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  **Create a new project** (or select an existing project).
3.  Navigate to **APIs & Services > Library**.
4.  Search for "Google Drive API" and **enable it**.

#### **2. Create Credentials**

**Create API Key**
1.  Navigate to **APIs & Services > Credentials**.
2.  Click **+ CREATE CREDENTIALS**.
3.  Select **API key**.
4.  Copy the generated API key and save it for later use.

**Create OAuth 2.0 Client ID**
1.  On the same page, click **+ CREATE CREDENTIALS** again.
2.  Select **OAuth 2.0 client ID**.
3.  **⚠️ IMPORTANT**: For **Application type**, select **Web application** (NOT Desktop application!)
    * If you select "Desktop application", the "Authorized JavaScript origins" option will not appear.
4.  Enter a **Name** (e.g., "Obsidian GDrive Sync").

#### **3. Configure Authorized JavaScript Origins**

In your **Web application** OAuth 2.0 client ID settings, you must add the following URLs to **Authorized JavaScript origins**:

```
http://localhost
https://localhost
http://127.0.0.1
https://127.0.0.1
app://obsidian.md
capacitor://localhost
```

⚠️ **Skipping this step will result in "authentication failed" errors!**

### 3. Plugin Configuration

1.  Open Obsidian `Settings`.
2.  Navigate to `Google Drive Sync` settings.
3.  **Authentication Tab**:
    * Paste your **Client ID**, **Client Secret**, and **API Key** into the respective fields.
    * Click the **"🔗 Authenticate"** button. A browser window will open asking you to authorize the application.
    * After authorizing, you will receive an **authorization code**. Copy this code.
    * Paste the copied code into the **"Paste Authorization Code"** field in the plugin settings and click **"Exchange for Token"**.
    * You should see a "✅ Authentication successful!" notice.
    * (Optional) Click **"🧪 Test Connection"** to verify your setup.
    * (Optional) Click **"🚪 Sign Out"** to revoke access and clear your tokens.
4.  **Sync Configuration Tab**:
    * **Sync Whole Vault**: Enable this to sync your entire Obsidian vault. If disabled, you can select specific Google Drive folders.
    * **Google Drive Folders**:
        * If "Sync Whole Vault" is off, click **"📁 Browse Google Drive"**. A modal will appear listing your Google Drive folders.
        * Select the folders you want to sync. The plugin will create corresponding local folders in your vault if they don't exist.
        * You can also create new folders directly from this modal.
    * **Sync Direction**: Choose between "Bidirectional", "Upload Only", or "Download Only".
    * **Conflict Resolution**: Decide how to handle files modified in both locations. "Use Newer File" is recommended.
    * **Include Subfolders**: Toggle whether to recursively sync files within subfolders of your chosen sync folders.
    * **Create Missing Folders**: Automatically create local folders if they exist on Google Drive but not locally during download.

### 4. Start Syncing

1.  **Manual Sync**:
    * Click the **cloud icon** in the left ribbon pane.
    * Or, open the Command Palette (`Ctrl/Cmd + P`) and search for "Google Drive Sync". You can choose from "Sync with Google Drive", "Download from Google Drive", or "Upload to Google Drive".
    * A progress modal will appear showing the sync status.
2.  **Automatic Sync**:
    * In the **Advanced** tab, enable **"Auto Sync"**.
    * Adjust the **"Sync Interval"** (in minutes) using the slider. The plugin will automatically sync your vault at the specified interval.

## ⚙️ Advanced Settings

* **Sync Mode**:
    * `Always sync`: Forces a sync every time regardless of modifications.
    * `Modified time comparison`: (Recommended) Syncs only if the modification timestamp differs.
    * `Content checksum comparison`: (Most accurate, but slower) Syncs only if the file content (hash) differs.
* **Root Folder Name**: Customize the name of the top-level folder created by the plugin in your Google Drive (default: `Obsidian-Sync`).
* **Troubleshooting**:
    * **Clear Cache**: Clears the internal folder ID cache. Useful if Google Drive folder structures change frequently.
    * **Export Logs**: Copies internal plugin settings and status to your clipboard for debugging purposes.
    * **Reset Settings**: Resets all plugin settings to their default values. Use with caution.
* **Debug Auto Sync Status**: Provides detailed information about the current auto-sync state in the developer console.

## ⚠️ Important Notes

* **Security**: Your API credentials and tokens are stored securely within Obsidian's configuration. However, always exercise caution when sharing sensitive information.
* **File Types**: Only a limited set of file types are currently supported for sync (`.md`, `.txt`, `.json`, `.csv`, `.html`, `.css`, `.js`). Other file types will be ignored.
* **Large Vaults**: Initial sync of very large vaults might take a considerable amount of time depending on your internet speed and Google Drive API rate limits.
* **Rate Limits**: Google Drive API has usage limits. Excessive syncing might temporarily block your access.
* **Mobile Sync**: On mobile (iOS/Android), direct file system time synchronization might not be possible due to platform restrictions. The plugin attempts to work around this using Obsidian's internal APIs.

## 🤝 Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue on the [GitHub repository](https://github.com/paasup/obsidian-gdrive-sync-plugin/issues).

If you'd like to contribute code, please fork the repository and submit a pull request.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.