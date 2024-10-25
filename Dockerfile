FROM node:alpine
COPY package.json ./
RUN yarn global add pnpm pm2 husky && pnpm install -P

WORKDIR /app

COPY pm2.json ./
COPY dist ./dist

CMD [ "pm2-runtime", "start", "pm2.json" ]
