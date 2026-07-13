# louielabs.com — one static page served by nginx. No build step: the site is
# self-contained index.html; preview.png is the link-preview card that og/twitter
# meta tags point at (https://louielabs.com/preview.png).
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY preview.png /usr/share/nginx/html/preview.png
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
