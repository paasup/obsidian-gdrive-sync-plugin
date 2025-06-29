// types.d.ts
import { App, PluginSettingTab } from 'obsidian';

declare global {
    interface Window {
        gapi: any;
        google: any;
    }
    
    // Google API Client Library types
    var gapi: {
        load: (apis: string, options: { callback: () => void; onerror: () => void }) => void;
        client: {
            init: (config: {
                apiKey: string;
                discoveryDocs: string[];
            }) => Promise<void>;
            drive: any;
            getToken: () => any;
            setToken: (token: { access_token: string }) => void;
        };
    };

    // Google Identity Services types
    var google: {
        accounts: {
            oauth2: {
                initTokenClient: (config: {
                    client_id: string;
                    scope: string;
                    callback: (response: {
                        access_token: string;
                        expires_in: number;
                        scope: string;
                        token_type: string;
                        error?: string;
                        error_description?: string;
                    }) => void;
                    error_callback?: (error: any) => void;
                }) => {
                    requestAccessToken: (options?: { prompt?: string }) => void;
                };
                hasGrantedAllScopes: (tokenResponse: any, ...scopes: string[]) => boolean;
                hasGrantedAnyScope: (tokenResponse: any, ...scopes: string[]) => boolean;
                revoke: (accessToken: string, callback?: () => void) => void;
            };
        };
    };
}
