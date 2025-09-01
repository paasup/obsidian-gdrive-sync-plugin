package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// Configuration
type Config struct {
	Port         string `json:"port"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	RedirectURI  string `json:"redirect_uri"`
	SecretKeys   map[string]UserConfig `json:"secret_keys"`
}

type UserConfig struct {
	UserID      string `json:"user_id"`
	RateLimit   int    `json:"rate_limit"`
	Permissions []string `json:"permissions"`
}

// OAuth session management
type AuthSession struct {
	SessionID   string    `json:"session_id"`
	State       string    `json:"state"`
	AuthURL     string    `json:"auth_url"`
	Status      string    `json:"status"` // pending, completed, failed
	AccessToken string    `json:"access_token,omitempty"`
	RefreshToken string   `json:"refresh_token,omitempty"`
	ExpiresAt   int64     `json:"expires_at,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UserID      string    `json:"user_id"`
}

// Global variables
var (
	config       Config
	oauthConfig  *oauth2.Config
	authSessions = make(map[string]*AuthSession)
	sessionMutex sync.RWMutex
)

// Response structures
type AuthInitiateResponse struct {
	AuthURL   string `json:"auth_url"`
	SessionID string `json:"session_id"`
}

type AuthStatusResponse struct {
	Status       string `json:"status"`
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
}

type HealthResponse struct {
	Status    string `json:"status"`
	Version   string `json:"version"`
	Timestamp int64  `json:"timestamp"`
}

func main() {
	// Load configuration
	if err := loadConfig(); err != nil {
		log.Fatal("Failed to load configuration:", err)
	}

	// Setup OAuth configuration
	setupOAuth()

	// Setup HTTP routes
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/auth/initiate", handleAuthInitiate)
	http.HandleFunc("/auth/callback", handleAuthCallback)
	http.HandleFunc("/auth/status/", handleAuthStatus)
	http.HandleFunc("/api/drive/", handleDriveAPI)

	port := config.Port
	if port == "" {
		port = "8080"
	}

	log.Printf("Starting OAuth Proxy Server on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func loadConfig() error {
	// Try to load from config.json, fallback to environment variables
	configFile := "config.json"
	if _, err := os.Stat(configFile); err == nil {
		data, err := os.ReadFile(configFile)
		if err != nil {
			return err
		}
		return json.Unmarshal(data, &config)
	}

	// Fallback to environment variables
	config = Config{
		Port:         os.Getenv("PORT"),
		ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		RedirectURI:  os.Getenv("REDIRECT_URI"),
		SecretKeys:   make(map[string]UserConfig),
	}

	// Load secret keys from environment (for demo purposes)
	if secretKey := os.Getenv("DEMO_SECRET_KEY"); secretKey != "" {
		config.SecretKeys[secretKey] = UserConfig{
			UserID:      "demo_user",
			RateLimit:   100,
			Permissions: []string{"drive.read", "drive.write"},
		}
	}

	return nil
}

func setupOAuth() {
	oauthConfig = &oauth2.Config{
		ClientID:     config.ClientID,
		ClientSecret: config.ClientSecret,
		RedirectURL:  config.RedirectURI,
		Scopes:       []string{"https://www.googleapis.com/auth/drive"},
		Endpoint:     google.Endpoint,
	}

	if config.RedirectURI == "" {
		// Default redirect URI for the proxy server
		oauthConfig.RedirectURL = "http://localhost:8080/auth/callback"
	}
}

func validateSecretKey(r *http.Request) (*UserConfig, error) {
	secretKey := r.Header.Get("X-Secret-Key")
	if secretKey == "" {
		return nil, fmt.Errorf("missing secret key")
	}

	userConfig, exists := config.SecretKeys[secretKey]
	if !exists {
		return nil, fmt.Errorf("invalid secret key")
	}

	return &userConfig, nil
}

func generateSessionID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Validate secret key for health check
	if _, err := validateSecretKey(r); err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	response := HealthResponse{
		Status:    "healthy",
		Version:   "1.0.0",
		Timestamp: time.Now().Unix(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func handleAuthInitiate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Validate secret key
	userConfig, err := validateSecretKey(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Generate session
	sessionID := generateSessionID()
	state := generateSessionID()

	// Create OAuth URL
	authURL := oauthConfig.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.ApprovalForce)

	// Store session
	session := &AuthSession{
		SessionID: sessionID,
		State:     state,
		AuthURL:   authURL,
		Status:    "pending",
		CreatedAt: time.Now(),
		UserID:    userConfig.UserID,
	}

	sessionMutex.Lock()
	authSessions[sessionID] = session
	sessionMutex.Unlock()

	// Clean up old sessions (older than 10 minutes)
	go cleanupOldSessions()

	response := AuthInitiateResponse{
		AuthURL:   authURL,
		SessionID: sessionID,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")

	if code == "" || state == "" {
		http.Error(w, "Missing code or state parameter", http.StatusBadRequest)
		return
	}

	// Find session by state
	sessionMutex.Lock()
	var targetSession *AuthSession
	for _, session := range authSessions {
		if session.State == state {
			targetSession = session
			break
		}
	}
	sessionMutex.Unlock()

	if targetSession == nil {
		http.Error(w, "Invalid state parameter", http.StatusBadRequest)
		return
	}

	// Exchange code for token
	ctx := context.Background()
	token, err := oauthConfig.Exchange(ctx, code)
	if err != nil {
		log.Printf("Token exchange failed: %v", err)
		targetSession.Status = "failed"
		http.Error(w, "Token exchange failed", http.StatusInternalServerError)
		return
	}

	// Update session with tokens
	sessionMutex.Lock()
	targetSession.Status = "completed"
	targetSession.AccessToken = token.AccessToken
	targetSession.RefreshToken = token.RefreshToken
	targetSession.ExpiresAt = token.Expiry.Unix()
	sessionMutex.Unlock()

	// Return success page
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprintf(w, `
		<html>
		<head><title>Authentication Successful</title></head>
		<body>
			<h1>✅ Authentication Successful!</h1>
			<p>You can now close this window and return to Obsidian.</p>
			<script>
				setTimeout(function() {
					window.close();
				}, 3000);
			</script>
		</body>
		</html>
	`)
}

func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Validate secret key
	if _, err := validateSecretKey(r); err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Extract session ID from URL
	sessionID := strings.TrimPrefix(r.URL.Path, "/auth/status/")
	if sessionID == "" {
		http.Error(w, "Missing session ID", http.StatusBadRequest)
		return
	}

	sessionMutex.RLock()
	session, exists := authSessions[sessionID]
	sessionMutex.RUnlock()

	if !exists {
		http.Error(w, "Session not found", http.StatusNotFound)
		return
	}

	response := AuthStatusResponse{
		Status: session.Status,
	}

	if session.Status == "completed" {
		response.AccessToken = session.AccessToken
		response.RefreshToken = session.RefreshToken
		response.ExpiresAt = session.ExpiresAt
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func handleDriveAPI(w http.ResponseWriter, r *http.Request) {
	// Validate secret key
	userConfig, err := validateSecretKey(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Get access token from header
	accessToken := r.Header.Get("X-Access-Token")
	if accessToken == "" {
		http.Error(w, "Missing access token", http.StatusBadRequest)
		return
	}

	// Extract API path
	apiPath := strings.TrimPrefix(r.URL.Path, "/api/drive/")
	
	// Construct Google Drive API URL
	var targetURL string
	if strings.HasPrefix(apiPath, "upload/") {
		targetURL = "https://www.googleapis.com/upload/drive/v3/" + strings.TrimPrefix(apiPath, "upload/")
	} else {
		targetURL = "https://www.googleapis.com/drive/v3/" + apiPath
	}

	// Add query parameters
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	// Create proxy request
	proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, "Failed to create proxy request", http.StatusInternalServerError)
		return
	}

	// Copy headers (except our custom ones)
	for name, values := range r.Header {
		if !strings.HasPrefix(name, "X-") {
			for _, value := range values {
				proxyReq.Header.Add(name, value)
			}
		}
	}

	// Set authorization header
	proxyReq.Header.Set("Authorization", "Bearer "+accessToken)

	// Log the request for debugging
	log.Printf("Proxying request for user %s: %s %s", userConfig.UserID, r.Method, targetURL)

	// Make the request
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(proxyReq)
	if err != nil {
		log.Printf("Proxy request failed: %v", err)
		http.Error(w, "Proxy request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for name, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}

	// Set status code
	w.WriteHeader(resp.StatusCode)

	// Copy response body
	io.Copy(w, resp.Body)
}

func cleanupOldSessions() {
	sessionMutex.Lock()
	defer sessionMutex.Unlock()

	cutoff := time.Now().Add(-10 * time.Minute)
	for sessionID, session := range authSessions {
		if session.CreatedAt.Before(cutoff) {
			delete(authSessions, sessionID)
		}
	}
}