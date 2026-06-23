FROM nginx:alpine

# Copy your static files into the Nginx server directory
COPY . /usr/share/nginx/html

# Inform Docker that the container listens on 8080
EXPOSE 8080

# Overwrite Nginx's default configuration port 80 to 8080 at runtime
CMD ["sh", "-c", "sed -i 's/listen       80;/listen       8080;/g' /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
