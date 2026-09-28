# -------------------------------
# 1. Build stage
# -------------------------------
FROM node:24-alpine AS builder

ENV BASEPATH=/wifi/

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY backend/package*.json ./backend/

# Copy all source
COPY . . 

RUN npm install --frozen-lockfile

WORKDIR /app/frontend/
RUN npm install --frozen-lockfile 

WORKDIR /app/backend/
RUN npm install --frozen-lockfile 

WORKDIR /app/
RUN npm run build
RUN find . -name "*.js.map" -delete

# -------------------------------
# 2. Production stage
# -------------------------------
FROM node:24-alpine AS runner

WORKDIR /app

# Copy only needed files
COPY backend/package*.json ./dist/backend/

WORKDIR /app/dist/frontend/

WORKDIR /app/dist/backend/
RUN npm install --omit=dev --frozen-lockfile

WORKDIR /app/
# Copy backend dist + frontend build
COPY --from=builder /app/backend/dist ./dist/backend
COPY --from=builder /app/frontend/dist ./dist/frontend

ADD backend/emailtemplate.mjml .

# Expose port (adjust if needed)
EXPOSE 3000

ENV BASEPATH=/wifi/

# Voucher history database (mount a volume here to keep it)
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD wget --spider -q http://localhost:3000${BASEPATH%/}/healthz || exit 1

# node:sqlite is still flagged experimental in Node 24
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/backend/server.js"]
