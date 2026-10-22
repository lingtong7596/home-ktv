# 家庭 KTV 服务器镜像：Node + ffmpeg（音轨分离必需）
FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY server/ /app/
EXPOSE 8080
CMD ["node", "server/server.js"]
