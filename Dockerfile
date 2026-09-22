# ---- 构建阶段：安装全部 workspace 依赖并构建 React 客户端 ----
FROM node:20-alpine AS build
WORKDIR /app

# 仅复制清单以利用 Docker 层缓存
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm install

# 构建客户端静态产物到 client/dist
COPY client ./client
RUN npm run build

# 再复制服务端源码；随后剔除开发依赖（Vite 等），精简运行层
COPY server ./server
RUN npm prune --omit=dev

# ---- 运行阶段：单进程 Node 服务（静态文件 + WebSocket 同端口）----
# npm workspaces 会把依赖提升到根 node_modules，运行时只需要它 + 服务端源码 + 构建产物
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
CMD ["node", "server/src/index.js"]
