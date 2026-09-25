# TechShare 后端镜像（podman/docker 通用）
FROM docker.io/library/node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# 纯 JS 依赖，无需编译工具链
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci --omit=dev --prefix backend

COPY . .
# 上传目录（R2 未配时的回落；生产建议走 R2，容器内仅做兼容）
RUN mkdir -p uploads/resources && chown -R node:node /app
USER node

WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
