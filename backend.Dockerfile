# Backend container — PHP REST API (talks to the database container)
FROM php:8.3-apache

ENV PORT=5000 \
    DB_BACKEND=mysql

# pdo_mysql and pdo_pgsql are both built in, so the same image works with either
# database. pdo_pgsql needs the libpq headers to build and libpq5 at runtime
# (apt-mark keeps libpq5 from being swept away with the headers).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev \
    && docker-php-ext-install pdo_mysql pdo_pgsql \
    && apt-mark manual libpq5 \
    && apt-get purge -y --auto-remove libpq-dev \
    && rm -rf /var/lib/apt/lists/* \
    && a2enmod rewrite headers \
    && printf '<Directory /var/www/html>\n    AllowOverride All\n</Directory>\n' \
       > /etc/apache2/conf-available/gitam.conf \
    && a2enconf gitam

WORKDIR /var/www/html

COPY api ./api

# Apache listens on $PORT
RUN sed -i 's/^Listen 80$/Listen ${PORT}/' /etc/apache2/ports.conf \
    && sed -i 's/:80>/:${PORT}>/' /etc/apache2/sites-available/000-default.conf

EXPOSE 5000
CMD ["apache2-foreground"]
