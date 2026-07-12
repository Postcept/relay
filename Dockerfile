FROM node:20-alpine
WORKDIR /relay
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY dist ./dist
# Outbound-only: nothing listens except the local health endpoint.
EXPOSE 8477
VOLUME ["/relay/data"]
ENV POSTCEPT_RELAY_DATA=/relay/data
ENTRYPOINT ["node", "dist/index.js"]
CMD ["run"]
