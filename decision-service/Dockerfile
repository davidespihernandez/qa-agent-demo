FROM oven/bun:1-slim
WORKDIR /app
COPY server.ts ./
USER bun
ENV PORT=80
EXPOSE 80
CMD ["bun", "server.ts"]
