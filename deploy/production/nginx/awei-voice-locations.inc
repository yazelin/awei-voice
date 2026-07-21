# Include only inside the existing ching-tech.ddns.net TLS server. These exact
# /awei-voice routes do not replace or overlap the old /taigi-tts service.

# auth_request executes after nginx's limit modules, so rejected origins still
# consume their per-IP request/connection allowance.
location = /_awei-web-origin-gate {
    internal;
    access_log off;
    if ($awei_web_origin_allowed = 0) { return 403; }
    return 204;
}

location = /awei-voice/health {
    server_tokens off;
    limit_except GET { deny all; }
    limit_req_status 429;
    limit_conn_status 429;
    limit_req zone=awei_health burst=3 nodelay;
    limit_conn awei_connections 6;
    limit_conn awei_global_connections 24;
    client_max_body_size 1k;
    access_log off;

    proxy_pass http://awei_voice_backend/health;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization "";
    proxy_set_header Cookie "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_hide_header Set-Cookie;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Expose-Headers;
    proxy_hide_header Access-Control-Max-Age;
    proxy_hide_header Vary;
    proxy_cache off;
    proxy_store off;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
    proxy_send_timeout 10s;

    add_header Cache-Control "no-store, max-age=0" always;
    add_header Pragma "no-cache" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
    add_header Access-Control-Allow-Origin $awei_web_cors_origin always;
    add_header Vary "Origin" always;
}

location = /awei-voice/v1/access {
    server_tokens off;
    limit_except GET OPTIONS { deny all; }
    limit_req_status 429;
    limit_conn_status 429;
    limit_req zone=awei_access burst=5 nodelay;
    limit_conn awei_connections 6;
    limit_conn awei_global_connections 24;
    auth_request /_awei-web-origin-gate;
    client_max_body_size 1k;
    access_log off;

    proxy_pass http://awei_voice_backend/v1/access;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Cookie "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_hide_header Set-Cookie;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Expose-Headers;
    proxy_hide_header Access-Control-Max-Age;
    proxy_hide_header Vary;
    proxy_cache off;
    proxy_store off;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
    proxy_send_timeout 10s;

    add_header Cache-Control "no-store, max-age=0" always;
    add_header Pragma "no-cache" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
    add_header Access-Control-Allow-Origin $awei_web_cors_origin always;
    add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    add_header Access-Control-Expose-Headers "Retry-After, X-RateLimit-Reset, X-RateLimit-Remaining, X-RateLimit-Scope" always;
    add_header Access-Control-Max-Age "600" always;
    add_header Vary "Origin" always;
}

location = /awei-voice/v1/synthesis-jobs {
    server_tokens off;
    limit_except POST OPTIONS { deny all; }
    limit_req_status 429;
    limit_conn_status 429;
    limit_req zone=awei_create burst=3 nodelay;
    limit_conn awei_connections 6;
    limit_conn awei_global_connections 24;
    auth_request /_awei-web-origin-gate;
    client_max_body_size 32k;
    client_body_buffer_size 32k;
    client_body_timeout 10s;
    access_log off;

    proxy_pass http://awei_voice_backend/v1/synthesis-jobs;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Cookie "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_hide_header Set-Cookie;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Expose-Headers;
    proxy_hide_header Access-Control-Max-Age;
    proxy_hide_header Vary;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_cache off;
    proxy_store off;
    proxy_connect_timeout 3s;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;

    add_header Cache-Control "no-store, max-age=0" always;
    add_header Pragma "no-cache" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
    add_header Access-Control-Allow-Origin $awei_web_cors_origin always;
    add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    add_header Access-Control-Expose-Headers "Retry-After, X-RateLimit-Reset, X-RateLimit-Remaining, X-RateLimit-Scope" always;
    add_header Access-Control-Max-Age "600" always;
    add_header Vary "Origin" always;
}

location ^~ /awei-voice/v1/synthesis-jobs/ {
    server_tokens off;
    limit_except GET DELETE OPTIONS { deny all; }
    limit_req_status 429;
    limit_conn_status 429;
    limit_req zone=awei_jobs burst=30 nodelay;
    limit_conn awei_connections 6;
    limit_conn awei_global_connections 24;
    auth_request /_awei-web-origin-gate;
    client_max_body_size 1k;
    client_body_timeout 5s;
    access_log off;

    proxy_pass http://awei_voice_backend/v1/synthesis-jobs/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Cookie "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_hide_header Set-Cookie;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    proxy_hide_header Access-Control-Allow-Credentials;
    proxy_hide_header Access-Control-Expose-Headers;
    proxy_hide_header Access-Control-Max-Age;
    proxy_hide_header Vary;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_cache off;
    proxy_store off;
    proxy_connect_timeout 3s;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;

    add_header Cache-Control "no-store, max-age=0" always;
    add_header Pragma "no-cache" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'" always;
    add_header Access-Control-Allow-Origin $awei_web_cors_origin always;
    add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    add_header Access-Control-Expose-Headers "Retry-After, X-RateLimit-Reset, X-RateLimit-Remaining, X-RateLimit-Scope" always;
    add_header Access-Control-Max-Age "600" always;
    add_header Vary "Origin" always;
}

# Only the bounded asynchronous contract is public.
location = /awei-voice/v1/synthesize {
    server_tokens off;
    access_log off;
    return 404;
}

location ^~ /awei-voice/v1/ {
    server_tokens off;
    access_log off;
    return 404;
}

location ^~ /awei-voice/ {
    server_tokens off;
    access_log off;
    return 404;
}

location = /awei-voice {
    server_tokens off;
    access_log off;
    return 404;
}
