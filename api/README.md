# Pending Sign-Out Cloud API

This is the cloud API for handling student sign-out submissions.

## Deployment to Vercel

### 1. Create Upstash Redis Database

1. Go to [Upstash Console](https://console.upstash.com/)
2. Create a new Redis database (free tier)
3. Copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

### 2. Deploy to Vercel

```bash
# From the api/ directory
cd api
npm install -g vercel
vercel login
vercel

# Set environment variables
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN

# Deploy to production
vercel --prod
```

### 3. Update Electron App

After deployment, update the `API_BASE_URL` in `pendingSignoutService.js` with your Vercel URL (e.g., `https://your-app.vercel.app`).

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/pending` | Get all pending records |
| POST | `/api/pending` | Create a pending record |
| PUT | `/api/pending/:id` | Update a pending record |
| DELETE | `/api/pending/cleanup` | Remove old resolved records |
| GET | `/signout/:token` | Display sign-out form |
| POST | `/signout/:token` | Submit sign-out time |

## Environment Variables

- `UPSTASH_REDIS_REST_URL` - Upstash Redis REST URL
- `UPSTASH_REDIS_REST_TOKEN` - Upstash Redis REST Token
