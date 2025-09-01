# Obsidian Google Drive OAuth Proxy Server

This is a Golang-based proxy server that simplifies Google Drive OAuth authentication for the Obsidian Google Drive Sync Plugin. Instead of users having to create their own Google Cloud projects and manage OAuth credentials, they can use this proxy server.

## Features

- **Simplified Authentication**: Users only need a secret key instead of managing Google OAuth credentials
- **Secure Token Management**: OAuth tokens are handled server-side
- **API Proxying**: All Google Drive API requests are proxied through the server
- **Multi-user Support**: Multiple users can use the same proxy with different secret keys
- **Rate Limiting**: Built-in rate limiting per user
- **Session Management**: Automatic cleanup of expired authentication sessions

## Architecture

```
Obsidian Plugin → Proxy Server → Google Drive API
```

1. Plugin initiates authentication via proxy server
2. Proxy server handles OAuth flow with Google
3. Plugin receives tokens through proxy
4. All API requests are routed through proxy server

## Setup

### Prerequisites

- Go 1.21 or later
- Google Cloud Project with Drive API enabled
- OAuth 2.0 credentials (Client ID and Client Secret)

### Installation

1. Clone the repository and navigate to the proxy server directory:
```bash
cd proxy-server
```

2. Install dependencies:
```bash
go mod tidy
```

3. Create configuration file:
```bash
cp config.example.json config.json
```

4. Edit `config.json` with your Google OAuth credentials:
```json
{
  "port": "8080",
  "client_id": "your-google-client-id.apps.googleusercontent.com",
  "client_secret": "your-google-client-secret",
  "redirect_uri": "http://localhost:8080/auth/callback",
  "secret_keys": {
    "your-secret-key-here": {
      "user_id": "user1",
      "rate_limit": 100,
      "permissions": ["drive.read", "drive.write"]
    }
  }
}
```

### Running the Server

```bash
go run main.go
```

Or build and run:
```bash
go build -o proxy-server main.go
./proxy-server
```

The server will start on the configured port (default: 8080).

## API Endpoints

### Health Check
```
GET /health
Headers: X-Secret-Key: your-secret-key
```

### Initiate Authentication
```
POST /auth/initiate
Headers: X-Secret-Key: your-secret-key
Body: {"client_type": "obsidian_plugin", "redirect_uri": "urn:ietf:wg:oauth:2.0:oob"}
```

### Check Authentication Status
```
GET /auth/status/{session_id}
Headers: X-Secret-Key: your-secret-key
```

### Proxy Google Drive API
```
ANY /api/drive/{api_path}
Headers: 
  X-Secret-Key: your-secret-key
  X-Access-Token: access-token
```

## Configuration

### Environment Variables (Alternative to config.json)

- `PORT`: Server port (default: 8080)
- `GOOGLE_CLIENT_ID`: Google OAuth Client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth Client Secret
- `REDIRECT_URI`: OAuth redirect URI
- `DEMO_SECRET_KEY`: Demo secret key for testing

### Secret Keys

Each secret key in the configuration represents a user and includes:
- `user_id`: Unique identifier for the user
- `rate_limit`: Maximum requests per minute
- `permissions`: Array of permissions (currently informational)

## Security Considerations

- **Secret Keys**: Keep secret keys confidential and rotate them regularly
- **HTTPS**: Use HTTPS in production environments
- **Rate Limiting**: Configure appropriate rate limits for your use case
- **Token Storage**: Tokens are stored in memory and cleared on server restart
- **Network Security**: Consider running behind a reverse proxy with additional security measures

## Plugin Configuration

In the Obsidian plugin settings:
1. Enable "Use Proxy Server"
2. Set "Proxy Server URL" to your proxy server (e.g., `http://localhost:8080`)
3. Set "Secret Key" to one of the configured secret keys
4. Use "Authenticate via Proxy" instead of the direct OAuth flow

## Troubleshooting

### Common Issues

1. **Invalid Secret Key**: Ensure the secret key matches one in your configuration
2. **Connection Failed**: Check if the proxy server is running and accessible
3. **OAuth Errors**: Verify Google OAuth credentials and redirect URI
4. **Rate Limiting**: Check if you've exceeded the configured rate limit

### Logs

The server logs all requests and errors. Check the console output for debugging information.

## Development

### Building for Production

```bash
# Build for Linux
GOOS=linux GOARCH=amd64 go build -o proxy-server-linux main.go

# Build for Windows
GOOS=windows GOARCH=amd64 go build -o proxy-server-windows.exe main.go

# Build for macOS
GOOS=darwin GOARCH=amd64 go build -o proxy-server-macos main.go
```

### Docker Support

Create a `Dockerfile`:
```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o proxy-server main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/proxy-server .
COPY --from=builder /app/config.json .
EXPOSE 8080
CMD ["./proxy-server"]
```

## License

This proxy server is part of the Obsidian Google Drive Sync Plugin project.