-- runs once on first container start (docker-entrypoint-initdb.d)
create extension if not exists vector;
create role app_user login password 'app_user' nosuperuser nobypassrls;
grant connect on database ecom to app_user;
