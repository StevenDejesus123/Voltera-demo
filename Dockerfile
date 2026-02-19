# Build stage
FROM node:18-slim AS builder

WORKDIR /app

COPY package.json ./
RUN npm install -g npm@latest && npm install

COPY . .
RUN npm run build

# Production stage
FROM node:18-slim

WORKDIR /app

RUN npm install -g serve

COPY --from=builder /app/build ./build

EXPOSE 3000

CMD serve -s build -l ${PORT:-3000}
