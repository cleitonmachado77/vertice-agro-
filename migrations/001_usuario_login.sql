PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE Usuario_nova (
    idUsuario INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL,
    Login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    Senha TEXT NOT NULL,
    Situacao TEXT NOT NULL DEFAULT 'Ativo' CHECK (Situacao IN ('Ativo', 'Inativo')),
    Perfil TEXT NOT NULL CHECK (Perfil IN ('Administrador', 'Gestor', 'Produtor'))
);

INSERT INTO Usuario_nova (idUsuario, Nome, Login, Senha, Situacao, Perfil)
SELECT idUsuario, Nome, 'usuario_' || idUsuario, Senha, Situacao, Perfil
FROM Usuario;

DROP TABLE Usuario;
ALTER TABLE Usuario_nova RENAME TO Usuario;

COMMIT;
PRAGMA foreign_keys = ON;