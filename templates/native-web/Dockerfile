FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/product-sdk/package.json packages/product-sdk/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci
COPY packages ./packages
COPY apps ./apps
COPY db ./db
COPY product.manifest.json ./product.manifest.json
RUN npm run build && test -f apps/api/dist/scripts/create-user.js

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/product-sdk/package.json packages/product-sdk/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @polar/native-web-api --workspace @polar/native-web-product-sdk
COPY --from=build /app/packages/product-sdk/dist ./packages/product-sdk/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/db/migrations ./db/migrations
COPY product.manifest.json ./product.manifest.json
EXPOSE 3920
CMD ["node", "apps/api/dist/server.js"]
