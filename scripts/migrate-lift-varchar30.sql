-- 把上传/导出相关的短字段全升级到 TEXT，避免长描述被截断报错
-- 涉及：employees.id_card, employees.phone, employees.status, health_checks.overall_result, health_checks.source
ALTER TABLE employees ALTER COLUMN id_card TYPE TEXT;
ALTER TABLE employees ALTER COLUMN phone TYPE TEXT;
ALTER TABLE employees ALTER COLUMN status TYPE TEXT;
ALTER TABLE health_checks ALTER COLUMN overall_result TYPE TEXT;
ALTER TABLE health_checks ALTER COLUMN source TYPE TEXT;
ALTER TABLE health_checks ALTER COLUMN vendor TYPE TEXT;
