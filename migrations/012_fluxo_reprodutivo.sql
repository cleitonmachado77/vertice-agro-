BEGIN;

ALTER TABLE Propriedade
ADD COLUMN DiasGestacao INTEGER NOT NULL DEFAULT 282 CHECK (DiasGestacao > 0);

ALTER TABLE TipoParto
ADD COLUMN Quantidade INTEGER NOT NULL DEFAULT 1 CHECK (Quantidade > 0);

UPDATE TipoParto SET Quantidade = 2 WHERE lower(Nome) LIKE '%gemelar%';

ALTER TABLE Prenhez
ADD COLUMN Status TEXT NOT NULL DEFAULT 'Prenhez Pendente'
CHECK (Status IN ('Prenhez Pendente', 'Prenhez Confirmada', 'Parto Realizado'));

ALTER TABLE Prenhez
ADD COLUMN DiasPrenhe INTEGER CHECK (DiasPrenhe IS NULL OR DiasPrenhe >= 0);

ALTER TABLE Animal
ADD COLUMN Animal_idAnimalPai INTEGER REFERENCES Animal(idAnimal) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE Animal
ADD COLUMN Animal_idAnimalMae INTEGER REFERENCES Animal(idAnimal) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE Animal
ADD COLUMN StatusReprodutivo TEXT NOT NULL DEFAULT 'Vazia'
CHECK (StatusReprodutivo IN ('Vazia', 'Prenhez Pendente', 'Prenhez Confirmada', 'Em Lactação', 'Não aplicável'));

UPDATE Animal SET StatusReprodutivo = 'Não aplicável' WHERE Sexo = 'M';

COMMIT;