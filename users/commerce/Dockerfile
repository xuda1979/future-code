FROM node:24-bookworm-slim
WORKDIR /app
COPY users/catalog.mjs users/releases.json ./users/
COPY users/commerce ./users/commerce
ENV NODE_ENV=production LISTEN_HOST=0.0.0.0 PORT=8787 COMMERCE_DB=/data/commerce.sqlite
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "users/commerce/server.mjs"]
