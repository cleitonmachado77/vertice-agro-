PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS CooperativaAssociacao (
    idCooperativaAssociacao INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL,
    Fone_Whats TEXT,
    Email TEXT,
    Contato TEXT,
    Fone_Contato TEXT,
    Endereco TEXT,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS Usuario (
    idUsuario INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL,
    Login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    Senha TEXT NOT NULL,
    Situacao TEXT NOT NULL DEFAULT 'Ativo' CHECK (Situacao IN ('Ativo', 'Inativo')),
    Perfil TEXT NOT NULL CHECK (Perfil IN ('Administrador', 'Gestor', 'Produtor'))
);

CREATE TABLE IF NOT EXISTS UsuarioCooperativaAssociacao (
    Usuario_idUsuario INTEGER NOT NULL,
    CooperativaAssociacao_idCooperativaAssociacao INTEGER NOT NULL,
    PRIMARY KEY (Usuario_idUsuario, CooperativaAssociacao_idCooperativaAssociacao),
    FOREIGN KEY (Usuario_idUsuario) REFERENCES Usuario(idUsuario) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (CooperativaAssociacao_idCooperativaAssociacao) REFERENCES CooperativaAssociacao(idCooperativaAssociacao) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Estado (
    idEstado INTEGER PRIMARY KEY,
    Sigla TEXT NOT NULL UNIQUE,
    Nome TEXT NOT NULL UNIQUE,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS Municipio (
    idMunicipio INTEGER PRIMARY KEY,
    Estado_idEstado INTEGER NOT NULL,
    Nome TEXT NOT NULL,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    UNIQUE (Estado_idEstado, Nome),
    FOREIGN KEY (Estado_idEstado) REFERENCES Estado(idEstado) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Unidade (
    idUnidade INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL UNIQUE,
    Sigla TEXT NOT NULL UNIQUE,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS UnidadeArea (
    idUnidadeArea INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL UNIQUE,
    Sigla TEXT NOT NULL UNIQUE,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS Atividade (
    idAtividade INTEGER PRIMARY KEY,
    Descricao TEXT NOT NULL UNIQUE,
    Agricultura INTEGER NOT NULL DEFAULT 0 CHECK (Agricultura IN (0, 1)),
    Pecuaria INTEGER NOT NULL DEFAULT 0 CHECK (Pecuaria IN (0, 1)),
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS SafraPeriodo (
    idSafraPeriodo INTEGER PRIMARY KEY,
    Descricao TEXT NOT NULL,
    Inicio TEXT NOT NULL,
    Termino TEXT NOT NULL,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    CHECK (date(Inicio) IS NOT NULL),
    CHECK (date(Termino) IS NOT NULL),
    CHECK (date(Termino) >= date(Inicio))
);

CREATE TABLE IF NOT EXISTS Categoria (
    idCategoria INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL CHECK (length(trim(Nome)) > 0),
    Sexo TEXT CHECK (Sexo IS NULL OR Sexo IN ('M', 'F')),
    IdadeMinima REAL NOT NULL CHECK (IdadeMinima >= 0),
    IdadeMaxima REAL NOT NULL CHECK (IdadeMaxima >= IdadeMinima),
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    UNIQUE (Nome, Sexo)
);

CREATE TABLE IF NOT EXISTS MotivoSaida (
    idMotivoSaida INTEGER PRIMARY KEY,
    Descricao TEXT NOT NULL UNIQUE,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS TipoPrenhez (
    idTipoPrenhez INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL UNIQUE,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS TipoParto (
    idTipoParto INTEGER PRIMARY KEY,
    Nome TEXT NOT NULL UNIQUE,
    Quantidade INTEGER NOT NULL DEFAULT 1 CHECK (Quantidade > 0),
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS Comprador (
    idComprador INTEGER PRIMARY KEY,
    NomeComprador TEXT NOT NULL,
    Fone TEXT,
    EmailComprador TEXT,
    Contato TEXT,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS Produtor (
    idProdutor INTEGER PRIMARY KEY,
    Usuario_idUsuario INTEGER NOT NULL UNIQUE,
    CooperativaAssociacao_idCooperativaAssociacao INTEGER NOT NULL,
    Nome TEXT NOT NULL,
    Fone TEXT,
    Email TEXT,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    FOREIGN KEY (Usuario_idUsuario) REFERENCES Usuario(idUsuario) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (CooperativaAssociacao_idCooperativaAssociacao) REFERENCES CooperativaAssociacao(idCooperativaAssociacao) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Propriedade (
    idPropriedade INTEGER PRIMARY KEY,
    Produtor_idProdutor INTEGER NOT NULL,
    Municipio_idMunicipio INTEGER NOT NULL,
    Nome TEXT NOT NULL,
    Fone_Whats TEXT,
    Contato TEXT,
    Fone_Contato TEXT,
    Localizacao TEXT,
    AreaTotal REAL CHECK (AreaTotal IS NULL OR AreaTotal >= 0),
    UnidadeArea_idUnidadeArea INTEGER,
    DiasGestacao INTEGER NOT NULL DEFAULT 282 CHECK (DiasGestacao > 0),
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    FOREIGN KEY (Produtor_idProdutor) REFERENCES Produtor(idProdutor) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Municipio_idMunicipio) REFERENCES Municipio(idMunicipio) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (UnidadeArea_idUnidadeArea) REFERENCES UnidadeArea(idUnidadeArea) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS AtividadePropriedade (
    idAtividadePropriedade INTEGER PRIMARY KEY,
    SafraPeriodo_idSafraPeriodo INTEGER NOT NULL,
    Atividade_idAtividade INTEGER NOT NULL,
    Propriedade_idPropriedade INTEGER NOT NULL,
    IdadeCobertura REAL,
    AreaUtilizada REAL CHECK (AreaUtilizada IS NULL OR AreaUtilizada >= 0),
    UnidadeArea_idUnidadeArea INTEGER,
    Descricao TEXT,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    UNIQUE (SafraPeriodo_idSafraPeriodo, Atividade_idAtividade, Propriedade_idPropriedade),
    FOREIGN KEY (SafraPeriodo_idSafraPeriodo) REFERENCES SafraPeriodo(idSafraPeriodo) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Atividade_idAtividade) REFERENCES Atividade(idAtividade) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Propriedade_idPropriedade) REFERENCES Propriedade(idPropriedade) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (UnidadeArea_idUnidadeArea) REFERENCES UnidadeArea(idUnidadeArea) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Produto (
    idProduto INTEGER PRIMARY KEY,
    Atividade_idAtividade INTEGER NOT NULL,
    Unidade_idUnidade INTEGER NOT NULL,
    Nome TEXT NOT NULL UNIQUE,
    Descricao TEXT,
    DiasProducao INTEGER CHECK (DiasProducao IS NULL OR DiasProducao >= 0),
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    FOREIGN KEY (Atividade_idAtividade) REFERENCES Atividade(idAtividade) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Unidade_idUnidade) REFERENCES Unidade(idUnidade) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS TalhaoArea (
    idTalhaoArea INTEGER PRIMARY KEY,
    Propriedade_idPropriedade INTEGER NOT NULL,
    Descricao TEXT NOT NULL,
    Area REAL NOT NULL CHECK (Area >= 0),
    UnidadeArea_idUnidadeArea INTEGER,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    FOREIGN KEY (Propriedade_idPropriedade) REFERENCES Propriedade(idPropriedade) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (UnidadeArea_idUnidadeArea) REFERENCES UnidadeArea(idUnidadeArea) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Producao (
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

CREATE TABLE IF NOT EXISTS Entrega (
    idEntrega INTEGER PRIMARY KEY,
    Unidade_idUnidade INTEGER NOT NULL,
    Comprador_idComprador INTEGER NOT NULL,
    Producao_idProducao INTEGER NOT NULL,
    DataEntrega TEXT NOT NULL,
    Quantidade REAL NOT NULL CHECK (Quantidade > 0),
    ValorUnitario NUMERIC CHECK (ValorUnitario IS NULL OR ValorUnitario >= 0),
    ValorTotal NUMERIC CHECK (ValorTotal IS NULL OR ValorTotal >= 0),
    DocumentoEntrega TEXT,
    CHECK (date(DataEntrega) IS NOT NULL),
    FOREIGN KEY (Unidade_idUnidade) REFERENCES Unidade(idUnidade) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Comprador_idComprador) REFERENCES Comprador(idComprador) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Producao_idProducao) REFERENCES Producao(IdProducao) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Demanda (
    idDemanda INTEGER PRIMARY KEY,
    Produto_idProduto INTEGER NOT NULL,
    Comprador_idComprador INTEGER NOT NULL,
    MesAno TEXT NOT NULL,
    Descricao TEXT,
    PrecoProduto NUMERIC CHECK (PrecoProduto IS NULL OR PrecoProduto >= 0),
    UNIQUE (Produto_idProduto, Comprador_idComprador, MesAno),
    FOREIGN KEY (Produto_idProduto) REFERENCES Produto(idProduto) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Comprador_idComprador) REFERENCES Comprador(idComprador) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS DemandaProdutor (
    idDemandaProdutor INTEGER PRIMARY KEY,
    Demanda_idDemanda INTEGER NOT NULL,
    Produtor_idProdutor INTEGER NOT NULL,
    QuantidadePrevista REAL NOT NULL CHECK (QuantidadePrevista > 0),
    Descricao TEXT,
    UNIQUE (Demanda_idDemanda, Produtor_idProdutor),
    FOREIGN KEY (Demanda_idDemanda) REFERENCES Demanda(idDemanda) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Produtor_idProdutor) REFERENCES Produtor(idProdutor) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Manejo (
    idManejo INTEGER PRIMARY KEY,
    Descricao TEXT NOT NULL UNIQUE,
    IntervaloSeguridade INTEGER,
    BoasPraticas TEXT,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1))
);

CREATE TABLE IF NOT EXISTS ManejoProduto (
    idManejoProduto INTEGER PRIMARY KEY,
    Manejo_idManejo INTEGER NOT NULL,
    Produto_idProduto INTEGER NOT NULL,
    Intervalo INTEGER,
    Ativo INTEGER NOT NULL DEFAULT 1 CHECK (Ativo IN (0, 1)),
    UNIQUE (Manejo_idManejo, Produto_idProduto),
    FOREIGN KEY (Manejo_idManejo) REFERENCES Manejo(idManejo) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Produto_idProduto) REFERENCES Produto(idProduto) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS AgendaManejo (
    idAgendaManejo INTEGER PRIMARY KEY,
    Producao_IdProducao INTEGER NOT NULL,
    Descricao TEXT,
    DataManejo TEXT NOT NULL,
    DataRealizacao TEXT,
    Situacao TEXT NOT NULL DEFAULT 'Pendente',
    Observacao TEXT,
    CHECK (date(DataManejo) IS NOT NULL),
    CHECK (DataRealizacao IS NULL OR date(DataRealizacao) IS NOT NULL),
    FOREIGN KEY (Producao_IdProducao) REFERENCES Producao(IdProducao) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Animal (
    idAnimal INTEGER PRIMARY KEY,
    Prenhez_idPrenhez INTEGER,
    MotivoSaida_idMotivoSaida INTEGER,
    Categoria_idCategoria INTEGER,
    AtividadePropriedade_idAtividadePropriedade INTEGER,
    Brinco TEXT,
    Nascimento TEXT,
    PrimeiroParto TEXT,
    DataSaida TEXT,
    Motivo TEXT,
    Sexo TEXT,
    PertenceRebanho INTEGER NOT NULL DEFAULT 1 CHECK (PertenceRebanho IN (0, 1)),
    Animal_idAnimalPai INTEGER,
    Animal_idAnimalMae INTEGER,
    StatusReprodutivo TEXT NOT NULL DEFAULT 'Vazia'
        CHECK (StatusReprodutivo IN ('Vazia', 'Prenhez Pendente', 'Prenhez Confirmada', 'Em Lactação', 'Não aplicável')),
    CHECK (Nascimento IS NULL OR date(Nascimento) IS NOT NULL),
    CHECK (PrimeiroParto IS NULL OR date(PrimeiroParto) IS NOT NULL),
    CHECK (DataSaida IS NULL OR date(DataSaida) IS NOT NULL),
    FOREIGN KEY (Prenhez_idPrenhez) REFERENCES Prenhez(idPrenhez) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (MotivoSaida_idMotivoSaida) REFERENCES MotivoSaida(idMotivoSaida) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Categoria_idCategoria) REFERENCES Categoria(idCategoria) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Animal_idAnimalPai) REFERENCES Animal(idAnimal) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Animal_idAnimalMae) REFERENCES Animal(idAnimal) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (AtividadePropriedade_idAtividadePropriedade) REFERENCES AtividadePropriedade(idAtividadePropriedade) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Prenhez (
    idPrenhez INTEGER PRIMARY KEY,
    TipoParto_idTipoParto INTEGER,
    Animal_idAnimalPai INTEGER,
    Animal_idAnimalMae INTEGER NOT NULL,
    TipoPrenhez_idTipoPrenhez INTEGER,
    DataPrenhez TEXT,
    DataParto TEXT,
    DataConfirmacao TEXT,
    Status TEXT NOT NULL DEFAULT 'Prenhez Pendente'
        CHECK (Status IN ('Prenhez Pendente', 'Prenhez Confirmada', 'Parto Realizado')),
    DiasPrenhe INTEGER CHECK (DiasPrenhe IS NULL OR DiasPrenhe >= 0),
    CHECK (DataPrenhez IS NULL OR date(DataPrenhez) IS NOT NULL),
    CHECK (DataParto IS NULL OR date(DataParto) IS NOT NULL),
    CHECK (DataConfirmacao IS NULL OR date(DataConfirmacao) IS NOT NULL),
    FOREIGN KEY (TipoParto_idTipoParto) REFERENCES TipoParto(idTipoParto) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Animal_idAnimalPai) REFERENCES Animal(idAnimal) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (Animal_idAnimalMae) REFERENCES Animal(idAnimal) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (TipoPrenhez_idTipoPrenhez) REFERENCES TipoPrenhez(idTipoPrenhez) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Lactacoes (
    idLactacoes INTEGER PRIMARY KEY,
    Animal_idAnimal INTEGER NOT NULL,
    Inicio TEXT NOT NULL,
    Termino TEXT,
    CHECK (date(Inicio) IS NOT NULL),
    CHECK (Termino IS NULL OR date(Termino) IS NOT NULL),
    CHECK (Termino IS NULL OR date(Termino) >= date(Inicio)),
    FOREIGN KEY (Animal_idAnimal) REFERENCES Animal(idAnimal) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS Lancamentos (
    idLancamentos INTEGER PRIMARY KEY,
    Lactacoes_idLactacoes INTEGER NOT NULL,
    DataLancamento TEXT NOT NULL,
    Quantidade REAL NOT NULL CHECK (Quantidade >= 0),
    CHECK (date(DataLancamento) IS NOT NULL),
    UNIQUE (Lactacoes_idLactacoes, DataLancamento),
    FOREIGN KEY (Lactacoes_idLactacoes) REFERENCES Lactacoes(idLactacoes) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS IX_Produtor_Associacao ON Produtor(CooperativaAssociacao_idCooperativaAssociacao);
CREATE INDEX IF NOT EXISTS IX_Propriedade_Produtor ON Propriedade(Produtor_idProdutor);
CREATE INDEX IF NOT EXISTS IX_AtividadePropriedade_Propriedade ON AtividadePropriedade(Propriedade_idPropriedade);
CREATE INDEX IF NOT EXISTS IX_Producao_AtividadePropriedade ON Producao(AtividadePropriedade_idAtividadePropriedade);
CREATE INDEX IF NOT EXISTS IX_Entrega_Data ON Entrega(DataEntrega);
CREATE INDEX IF NOT EXISTS IX_Demanda_MesAno ON Demanda(MesAno);
CREATE INDEX IF NOT EXISTS IX_Animal_AtividadePropriedade ON Animal(AtividadePropriedade_idAtividadePropriedade);
CREATE INDEX IF NOT EXISTS IX_Lancamentos_LactacaoData ON Lancamentos(Lactacoes_idLactacoes, DataLancamento);

PRAGMA user_version = 11;