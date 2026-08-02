FROM node:alpine

# 项目用 yarn 1.x 管理依赖（yarn.lock v1 格式），postinstall 会跑 husky && patch-package，
# patches/ 必须先就位（handlers.js 0.1.6 的 import.meta 修复依赖 patch 应用）。
# Node 20+ 镜像不再内置 yarn，需显式安装 yarn 1（corepack 默认只支持 berry）。
COPY package.json yarn.lock ./
COPY patches ./patches
RUN npm install -g yarn@1.22.22 && yarn install --production=false && yarn cache clean

WORKDIR /app

COPY pm2.json ./
COPY dist ./dist

CMD [ "node", "dist/index.cjs" ]
