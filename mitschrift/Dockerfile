# Mitschrift auf der CPU. Das Sprachmodell (rund 700 MB) steckt nicht im
# Abbild: Es kommt aus dem Volume von Antons Redekreis, der schon auf diesem
# Server laeuft. Abbild nach dessen Vorbild (node:22-slim, transcribe-cpp).
FROM node:22-slim

ENV NODE_ENV=production PORT=7884 MODELL_ORDNER=/models

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.mjs ./

USER node
EXPOSE 7884

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:7884/mitschrift/gesund').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
