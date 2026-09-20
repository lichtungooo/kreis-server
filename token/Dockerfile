FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

USER node
EXPOSE 7880

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O- http://localhost:7880/token/gesund || exit 1

CMD ["node", "server.js"]
