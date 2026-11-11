# One image for both services (and the tools): the command picks which one runs.
#   node dist/registration/main.js   the registration service (migrates the database, serves the admin pages)
#   node dist/class/main.js          the class service
#   node dist/tools/<name>.js        a tool

# Admin pages
FROM node:24-slim AS admin
WORKDIR /build/admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

# Server code, compiled
FROM node:24-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

# Production dependencies only
FROM node:24-slim AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
WORKDIR /app
COPY --from=deps /build/node_modules node_modules/
COPY --from=build /build/dist dist/
COPY --from=admin /build/admin/dist admin/dist/
COPY package.json ./
COPY school-rules/ school-rules/
COPY data/ data/
COPY config/school.example.json config/school.example.json
# The `node` user of the base image, not root.
USER node
EXPOSE 8080 8081
CMD ["node", "dist/registration/main.js"]
