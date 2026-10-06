PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE Categoria_nova (
    idCategoria INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL CHECK (length(trim(Nome)) > 0),
    Sexo TEXT CHECK (Sexo IS NULL OR Sexo IN ('M', 'F')),
    IdadeMinima REAL NOT NULL CHECK (IdadeMinima >= 0),
    IdadeMaxima REAL NOT NULL CHECK (IdadeMaxima >= IdadeMinima),
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    UNIQUE (Nome, Sexo)
);

INSERT INTO Categoria_nova (idCategoria, Nome, Sexo, IdadeMinima, IdadeMaxima, Ativo)
SELECT idCategoria, 'Pendente de classificação ' || idCategoria, NULL, IdadeMinima, IdadeMaxima, Ativo
FROM Categoria;

DROP TABLE Categoria;
ALTER TABLE Categoria_nova RENAME TO Categoria;

PRAGMA user_version = 8;
COMMIT;
PRAGMA foreign_keys = ON;