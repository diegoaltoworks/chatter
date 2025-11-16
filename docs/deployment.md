# Deployment Guide

This guide covers deploying Chatter to production on various platforms.

## Platform Requirements

**Chatter requires Bun runtime and long-running server processes.**

### ✅ Compatible Platforms

- **Google Cloud Run** - Generous free tier, auto-scaling
- **Fly.io** - Free tier, simple CLI deployment
- **Railway** - Auto-detects Dockerfile, GitHub integration
- **DigitalOcean App Platform** - Simple container deployment
- **AWS ECS/Fargate** - Enterprise-grade container orchestration
- **Azure Container Apps** - Microsoft's container platform
- **Any VPS with Docker** - Full control, predictable pricing (Ubuntu, Debian, etc.)

### ❌ NOT Compatible

- **Vercel, Netlify** - No Bun runtime support
- **AWS Lambda, Cloudflare Workers** - Serverless, not designed for long-running processes

**Why**: Chatter needs persistent processes for RAG embeddings, session state, and streaming responses.

## Docker Deployment

### Dockerfile

Create a `Dockerfile`:

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Build application
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Production image
FROM base AS release
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/config ./config
COPY --from=build /app/public ./public

# Run as non-root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 bunuser
USER bunuser

EXPOSE 8181
CMD ["bun", "dist/index.js"]
```

### Docker Compose

Create `docker-compose.yml` for local/VPS deployment:

```yaml
version: '3.8'

services:
  chatter:
    build: .
    ports:
      - "8181:8181"
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - PORT=8181
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8181/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

### Build and Run

```bash
# Build image
docker build -t chatter .

# Run container
docker run -p 8181:8181 --env-file .env chatter

# Or use Docker Compose
docker-compose up -d
docker-compose logs -f
```

## Platform-Specific Guides

### Google Cloud Run

**Best for**: Auto-scaling, generous free tier, managed infrastructure

#### Prerequisites
- Google Cloud account
- gcloud CLI installed
- Artifact Registry enabled

#### Setup

1. **Configure gcloud**:
```bash
gcloud config configurations create myproject
gcloud config set project your-project-id
gcloud auth login
```

2. **Create secrets in Secret Manager**:
```bash
# OpenAI
echo -n "sk-..." | gcloud secrets create OPENAI_API_KEY --data-file=-

# Turso
echo -n "libsql://..." | gcloud secrets create TURSO_URL --data-file=-
echo -n "..." | gcloud secrets create TURSO_AUTH_TOKEN --data-file=-

# Chatter secret
echo -n "your-secret" | gcloud secrets create CHATTER_SECRET --data-file=-

# Clerk (optional)
echo -n "pk_live_..." | gcloud secrets create CLERK_PUBLISHABLE_KEY --data-file=-
echo -n "https://..." | gcloud secrets create CLERK_FRONTEND_URL --data-file=-
echo -n "https://.../.well-known/jwks.json" | gcloud secrets create CLERK_JWKS_URL --data-file=-
echo -n "https://..." | gcloud secrets create CLERK_ISSUER --data-file=-
```

3. **Build and push image**:
```bash
# Configure Docker for Artifact Registry
gcloud auth configure-docker your-region-docker.pkg.dev

# Build image
docker build -t your-region-docker.pkg.dev/your-project/chatter/app:latest .

# Push to Artifact Registry
docker push your-region-docker.pkg.dev/your-project/chatter/app:latest
```

4. **Deploy to Cloud Run**:
```bash
gcloud run deploy chatter \
  --image your-region-docker.pkg.dev/your-project/chatter/app:latest \
  --platform managed \
  --region your-region \
  --allow-unauthenticated \
  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest,CHATTER_SECRET=CHATTER_SECRET:latest,TURSO_URL=TURSO_URL:latest,TURSO_AUTH_TOKEN=TURSO_AUTH_TOKEN:latest,CLERK_PUBLISHABLE_KEY=CLERK_PUBLISHABLE_KEY:latest,CLERK_FRONTEND_URL=CLERK_FRONTEND_URL:latest,CLERK_JWKS_URL=CLERK_JWKS_URL:latest,CLERK_ISSUER=CLERK_ISSUER:latest \
  --update-env-vars NODE_ENV=production,RATE_LIMIT_RPM_PUBLIC=60,RATE_LIMIT_RPM_PRIVATE=120
```

#### Automation with GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloud Run

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Build and push
        run: |
          gcloud builds submit --tag gcr.io/${{ secrets.GCP_PROJECT }}/chatter

      - name: Deploy
        run: |
          gcloud run deploy chatter \
            --image gcr.io/${{ secrets.GCP_PROJECT }}/chatter \
            --region us-central1 \
            --platform managed \
            --allow-unauthenticated \
            --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest,...
```

### Fly.io

**Best for**: Simple deployment, global edge network

#### Setup

1. **Install flyctl**:
```bash
curl -L https://fly.io/install.sh | sh
```

2. **Login and initialize**:
```bash
fly auth login
fly launch
```

3. **Configure secrets**:
```bash
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set TURSO_URL=libsql://...
fly secrets set TURSO_AUTH_TOKEN=...
fly secrets set CHATTER_SECRET=...
fly secrets set CLERK_PUBLISHABLE_KEY=pk_live_...
fly secrets set CLERK_FRONTEND_URL=https://...
fly secrets set CLERK_JWKS_URL=https://...
fly secrets set CLERK_ISSUER=https://...
```

4. **Deploy**:
```bash
fly deploy
```

#### fly.toml

```toml
app = "chatter"
primary_region = "iad"

[build]

[http_service]
  internal_port = 8181
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 1024
```

### Railway

**Best for**: Zero-config deployments, GitHub integration

#### Setup

1. **Connect GitHub repo**:
   - Visit [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository

2. **Configure environment variables**:
   - Go to project → Variables
   - Add all required environment variables

3. **Deploy**:
   - Railway auto-detects Dockerfile
   - Automatically builds and deploys on push

#### railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "numReplicas": 1,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### VPS (Ubuntu/Debian)

**Best for**: Full control, predictable costs

#### Setup

1. **Install Docker**:
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

2. **Clone repository**:
```bash
git clone https://github.com/your-org/your-bot.git
cd your-bot
```

3. **Configure environment**:
```bash
cp .env.sample .env
nano .env  # Add your secrets
```

4. **Start service**:
```bash
docker-compose up -d
```

5. **Set up reverse proxy** (nginx):
```nginx
server {
    listen 80;
    server_name bot.example.com;

    location / {
        proxy_pass http://localhost:8181;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

6. **Enable HTTPS** (Let's Encrypt):
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d bot.example.com
```

## Environment Variables in Production

Ensure all required variables are set:

```bash
# Required
OPENAI_API_KEY=sk-...
TURSO_URL=libsql://...
TURSO_AUTH_TOKEN=...
CHATTER_SECRET=...
NODE_ENV=production
PORT=8181

# Optional (for private chat)
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_FRONTEND_URL=https://...
CLERK_JWKS_URL=https://.../.well-known/jwks.json
CLERK_ISSUER=https://...

# Rate limits
RATE_LIMIT_RPM_PUBLIC=60
RATE_LIMIT_RPM_PRIVATE=120
```

## Health Checks

Add a health endpoint to your server:

```typescript
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});
```

Configure health checks in your deployment:

- **Google Cloud Run**: Automatically uses `/` endpoint
- **Fly.io**: Configure in `fly.toml`
- **Railway**: Automatically detects service health
- **Docker Compose**: Use `healthcheck` in docker-compose.yml

## Monitoring

### Logs

View logs on each platform:

```bash
# Google Cloud Run
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=chatter" --limit 50

# Fly.io
fly logs

# Railway
# View in web dashboard

# Docker Compose
docker-compose logs -f
```

### Metrics

Monitor:
- Request rate and latency
- OpenAI API usage and costs
- Turso database usage
- Memory and CPU usage
- Error rates

## Scaling

### Vertical Scaling (Increase Resources)

- **Cloud Run**: Increase memory/CPU in deployment config
- **Fly.io**: Change VM size in `fly.toml`
- **Railway**: Upgrade plan for more resources

### Horizontal Scaling (More Instances)

- **Cloud Run**: Automatic based on traffic
- **Fly.io**: Configure `min_machines_running` in `fly.toml`
- **Railway**: Increase `numReplicas` in config

**Note**: Chatter is stateless and can scale horizontally without issues.

## Security Checklist

- [ ] Use HTTPS in production
- [ ] Store secrets in secure secret managers (not in code)
- [ ] Enable rate limiting
- [ ] Configure CORS appropriately
- [ ] Use strong CHATTER_SECRET (min 32 chars)
- [ ] Keep dependencies updated
- [ ] Monitor for suspicious activity
- [ ] Set appropriate rate limits

## Troubleshooting

See [FAQs](./faqs.md) for common deployment issues.

## Next Steps

- [Client Setup](./client.md) - Integrate chat widgets
- [FAQs](./faqs.md) - Common questions and troubleshooting
