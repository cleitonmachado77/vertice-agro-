BEGIN IMMEDIATE;

ALTER TABLE Producao
ADD COLUMN AreaPlanejada REAL CHECK (AreaPlanejada IS NULL OR AreaPlanejada >= 0);

PRAGMA user_version = 10;
COMMIT;