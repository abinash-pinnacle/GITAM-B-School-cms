# Frontend container — Nginx serving the static UI + proxying /api to backend
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html /usr/share/nginx/html/index.html
COPY css   /usr/share/nginx/html/css
COPY js    /usr/share/nginx/html/js
COPY assets /usr/share/nginx/html/assets

# installable-app files — without these the browser never offers "Install"
COPY manifest.webmanifest /usr/share/nginx/html/manifest.webmanifest
COPY sw.js /usr/share/nginx/html/sw.js

# the Android app and the Digital Asset Links that verify it owns this domain
COPY apk /usr/share/nginx/html/apk
COPY .well-known /usr/share/nginx/html/.well-known

EXPOSE 80
