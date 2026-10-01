-- Zwei unabhängige Control-Server, zwei getrennte Datenbanken in derselben
-- Instanz. wave1 legt der Container selbst an (POSTGRES_DB), wave2 hier.
CREATE DATABASE wave2 OWNER wave;
