FROM node:20-alpine AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npx tsc -b && npx vite build

FROM node:20-alpine AS backend
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npx tsc

FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend /app/dist ./dist
COPY --from=frontend /app/web/dist ./web/dist
VOLUME /app/data
EXPOSE 3201
CMD ["node", "dist/src/index.js"]
