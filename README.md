# Vértice Agro

Aplicação web responsiva para gestão de propriedades rurais, com os dados no PostgreSQL do Supabase.

## Executar localmente

Requisitos: Node.js 24 ou superior e npm.

```powershell
npm install
npm start
```

Abra `http://127.0.0.1:3000`. No primeiro acesso, crie a conta Administrador. A senha deve ter pelo menos 12 caracteres; ela é armazenada como hash `scrypt`.

O banco é o Supabase. Copie as variáveis `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` e `PGPASSWORD` para um arquivo `.env` na raiz antes de iniciar. Esse arquivo não entra no Git.

## Incluído nesta etapa

- Setup inicial do Administrador, login e encerramento de sessão.
- Acesso aos módulos de acordo com o perfil.
- Painéis iniciais com dados limitados ao escopo do Administrador, Gestor ou Produtor.
- Gestão de usuários pelo Administrador, incluindo perfil, associação, redefinição de senha, inativação e exclusão protegida por integridade referencial.
- Cadastro de cooperativas/associações, com edição, inativação e exclusão bloqueada quando há vínculos.
- Cadastro de Estados e Municípios com seleção pelo nome do Estado e preservação dos vínculos.
- Cadastro de unidades de produção e de área, com inativação e exclusão protegida por referências.
- Parâmetros pecuários: categorias, motivos de saída, tipos de prenhez e tipos de parto.
- Cada parâmetro pecuário tem uma tela e item próprios no menu lateral.
- Categoria inclui nome e sexo do animal; faixas existentes são preservadas e sinalizadas para classificação quando o sexo ainda não era conhecido.
- Navegação administrativa por grupos sanfonados, com os cadastros individuais exibidos na área principal.
- Configurações compartilhadas de Atividade, Safra, Produto, Manejo, Comprador e Manejo por Produto para Administrador/Gestor.
- Cadastro de Produtores por Administrador/Gestor, com conta de acesso criada em conjunto, escopo por associação, inativação sincronizada e exclusão protegida por vínculos.
- Gestão de Produtores por Administrador/Gestor, com limite de associação, conta de acesso e inativação sincronizada.
- Gestão agrícola de Propriedades com filtro de associação, abas de dados/atividades/talhões e restrição às atividades classificadas como Agricultura.
- Planejamento de Produção por Produto/Propriedade, com quantidades previstas/realizadas, datas e registro de Entregas associadas ao Comprador.
- Ação Nova produção na listagem, retornando à lista após salvar.
- Planejamento de Produção por Produto/Propriedade e registro de Entregas associado à produção e ao comprador.

As telas e os fluxos completos do módulo de Pecuária de Leite serão construídos nas próximas etapas.

## Segurança

Por padrão, o servidor local aceita conexões somente do próprio computador. A sessão fica na tabela `app_session` do Supabase. Na Vercel, defina `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` e `SESSION_SECRET`. O `PGPORT` deve ser `5432`.