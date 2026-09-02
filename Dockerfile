# NMIET College Management System — single-container image (PHP + Apache)
# One web server serves the static frontend and the PHP API.
FROM php:8.3-apache

ENV PORT=5500 \
    NMIET_DB=/data/nmiet.db

# pdo_pgsql for managed Postgres (only pdo_sqlite ships with the base image)
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev \
    && docker-php-ext-install pdo_pgsql \
    && rm -rf /var/lib/apt/lists/*

# mod_rewrite powers api/.htaccess; mod_headers sets the cache policy
COPY apache-nmiet.conf /etc/apache2/conf-available/nmiet.conf
RUN a2enmod rewrite headers \
    && a2enconf nmiet

WORKDIR /var/www/html

# Copy the application code (see .dockerignore for what is excluded)
COPY . .

# /data holds the SQLite database; mount a volume here so it persists
RUN mkdir -p /data && chown -R www-data:www-data /data /var/www/html
VOLUME ["/data"]

# Apache listens on $PORT, which a container host is free to set for us
RUN sed -i 's/^Listen 80$/Listen ${PORT}/' /etc/apache2/ports.conf \
    && sed -i 's/:80>/:${PORT}>/' /etc/apache2/sites-available/000-default.conf

EXPOSE 5500

# Basic healthcheck — hits the API health endpoint on whatever PORT is configured
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD php -r 'exit(@file_get_contents("http://localhost:" . getenv("PORT") . "/api/health") ? 0 : 1);'

CMD ["apache2-foreground"]
