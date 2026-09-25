-- TechShare 初始化建表脚本（按 backend/server.js 查询反推）
-- 库名沿用 .env 中的 tech_share；create_time 全部给默认值，保证老代码不显式插入也能跑
-- 用法（容器内）: mysql -h mysql -uroot -p"$MYSQL_ROOT_PASSWORD" < backend/schema.sql

CREATE DATABASE IF NOT EXISTS `tech_share`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
USE `tech_share`;

-- 用户
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password` VARCHAR(255) NOT NULL COMMENT 'bcrypt 哈希',
  `role` VARCHAR(16) NOT NULL DEFAULT 'user' COMMENT 'admin / user',
  `email` VARCHAR(128) NULL,
  `signature` VARCHAR(255) NULL,
  `avatar` VARCHAR(1024) NULL COMMENT '本地 /uploads 路径或 R2 公网 URL',
  `token_version` INT NOT NULL DEFAULT 0 COMMENT '改密/重置时+1，旧 JWT 即刻失效',
  `create_time` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 资源（文件本体在 R2 或本地 uploads，表里只存元数据 + file_url）
CREATE TABLE IF NOT EXISTS `resources` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `category` VARCHAR(64) NULL,
  `file_url` VARCHAR(1024) NULL COMMENT '本地 /uploads 路径或 R2 公网 URL',
  `file_size` BIGINT NULL,
  `file_type` VARCHAR(128) NULL COMMENT 'mimetype',
  `description` TEXT NULL,
  `uploader` VARCHAR(64) NULL,
  `upload_time` DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_resources_title` (`title`),
  KEY `idx_resources_uploader` (`uploader`),
  KEY `idx_resources_upload_time` (`upload_time`),
  FULLTEXT KEY `ft_resources_title_desc` (`title`, `description`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 吐槽
CREATE TABLE IF NOT EXISTS `comments` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `content` TEXT NOT NULL,
  `create_time` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_comments_username` (`username`),
  KEY `idx_comments_create_time` (`create_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 论坛帖子
CREATE TABLE IF NOT EXISTS `posts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `content` MEDIUMTEXT NOT NULL,
  `username` VARCHAR(64) NOT NULL,
  `create_time` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_posts_username` (`username`),
  KEY `idx_posts_create_time` (`create_time`),
  FULLTEXT KEY `ft_posts_title_content` (`title`, `content`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 帖子回复
CREATE TABLE IF NOT EXISTS `post_comments` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `post_id` INT UNSIGNED NOT NULL,
  `username` VARCHAR(64) NOT NULL,
  `content` TEXT NOT NULL,
  `create_time` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_post_comments_post` (`post_id`, `create_time`),
  KEY `idx_post_comments_username` (`username`),
  CONSTRAINT `fk_post_comments_post` FOREIGN KEY (`post_id`)
    REFERENCES `posts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 帖子点赞（toggle：有则删、无则插；删帖自动级联清赞）
CREATE TABLE IF NOT EXISTS `post_likes` (
  `post_id` INT UNSIGNED NOT NULL,
  `username` VARCHAR(64) NOT NULL,
  `create_time` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`post_id`, `username`),
  KEY `idx_post_likes_user` (`username`),
  CONSTRAINT `fk_post_likes_post` FOREIGN KEY (`post_id`)
    REFERENCES `posts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 默认管理员：不在这里写死密码哈希。先正常注册一个用户，再执行：
--   UPDATE `users` SET `role` = 'admin' WHERE `username` = '你的用户名';
