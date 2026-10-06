BEGIN IMMEDIATE;

CREATE TABLE Producao_nova (
    IdProducao INTEGER PRIMARY KEY,
    Unidade_idUnidade INTEGER NOT NULL,
    Produto_idProduto INTEGER NOT NULL,
    TalhaoArea_idTalhaoArea INTEGER,
    AreaPlanejada REAL CHECK (AreaPlanejada IS NULL OR AreaPlanejada >= 0),
    AtividadePropriedade_idAtividadePropriedade INTEGER NOT NULL,
    InicioProducao TEXT,
    PrevisaoProducao TEXT,
    Previsao REAL CHECK (Previsao IS NULL OR Previsao >= 0),
    Realizado REAL CHECK (Realizado IS NULL OR Realizado >= 0),
    Situacao TEXT NOT NULL DEFAULT 'Planejada',
    Descricao TEXT,
    CHECK (InicioProducao IS NULL OR date(InicioProducao) IS NOT NULL),
    CHECK (PrevisaoProducao IS NULL OR date(PrevisaoProducao) IS NOT NULL),
    FOREIGN KEY (Unidade_idUnidade) REFERENCES Unidade(idUnidade) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Produto_idProduto) REFERENCES Produto(idProduto) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (TalhaoArea_idTalhaoArea) REFERENCES TalhaoArea(idTalhaoArea) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (AtividadePropriedade_idAtividadePropriedade) REFERENCES AtividadePropriedade(idAtividadePropriedade) ON UPDATE CASCADE ON DELETE RESTRICT
);

INSERT INTO Producao_nova (
    IdProducao, Unidade_idUnidade, Produto_idProduto, TalhaoArea_idTalhaoArea, AreaPlanejada,
    AtividadePropriedade_idAtividadePropriedade, InicioProducao, PrevisaoProducao, Previsao,
    Realizado, Situacao, Descricao
)
SELECT p.IdProducao, p.Unidade_idUnidade, pp.Produto_idProduto, p.TalhaoArea_idTalhaoArea, p.AreaPlanejada,
    p.AtividadePropriedade_idAtividadePropriedade, p.InicioProducao, p.PrevisaoProducao, p.Previsao,
    p.Realizado, p.Situacao, p.Descricao
FROM Producao p
JOIN ProdutoPropriedade pp ON pp.idProdutoPropriedade = p.ProdutoPropriedade_idProdutoPropriedade;

DROP TABLE Producao;
ALTER TABLE Producao_nova RENAME TO Producao;
DROP TABLE ProdutoPropriedade;

PRAGMA user_version = 11;
COMMIT;
