-- ============================================================================
-- Carteira Pessoal — esquema do banco de dados local (SQLite)
--
-- O banco nasce vazio. É criado na primeira abertura do app, durante o
-- onboarding, e alimentado apenas pelo que o usuário registra.
--
-- Convenção: colunas em snake_case; a camada de dados converte para camelCase
-- ao entregar os registros para a interface (mesmo contrato da planilha
-- original, o que mantém a importação de backups antigos compatível).
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Perfil e preferências
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profile (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  monthly_goal           REAL NOT NULL DEFAULT 0,
  emergency_reserve_goal REAL NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  type        TEXT NOT NULL DEFAULT 'text',  -- text | number | boolean | json
  description TEXT DEFAULT '',
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,   -- income | variableExpense | fixedExpense | investment
  name       TEXT NOT NULL,
  color      TEXT DEFAULT '',
  icon       TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (type, name)
);

-- ---------------------------------------------------------------------------
-- Contas bancárias
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_accounts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  account_type    TEXT NOT NULL,   -- CONTA_CORRENTE | CONTA_POUPANCA | CARTEIRA_DINHEIRO | CONTA_DIGITAL | OUTROS
  initial_balance REAL NOT NULL DEFAULT 0,
  current_balance REAL NOT NULL DEFAULT 0,
  color           TEXT DEFAULT '#4ea8ff',
  status          TEXT NOT NULL DEFAULT 'ATIVA',  -- ATIVA | INATIVA
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Entradas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incomes (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  category            TEXT NOT NULL,
  bank_account_id     TEXT NOT NULL REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  amount              REAL NOT NULL,
  date                TEXT NOT NULL,   -- YYYY-MM-DD
  description         TEXT DEFAULT '',
  notes               TEXT DEFAULT '',
  recurring_income_id TEXT DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incomes_date    ON incomes (date);
CREATE INDEX IF NOT EXISTS idx_incomes_account ON incomes (bank_account_id);

-- Receitas recorrentes: o espelho das despesas fixas para o lado das entradas.
CREATE TABLE IF NOT EXISTS recurring_incomes (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  source             TEXT NOT NULL,
  category           TEXT NOT NULL,
  default_account_id TEXT DEFAULT '',
  estimated_amount   REAL NOT NULL DEFAULT 0,
  receive_day        INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'ATIVA',   -- ATIVA | INATIVA
  notes              TEXT DEFAULT '',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Saídas
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS expenses (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL DEFAULT 'VARIAVEL',  -- VARIAVEL | FIXA
  category         TEXT NOT NULL,
  bank_account_id  TEXT DEFAULT '',
  payment_method   TEXT NOT NULL,   -- PIX | DEBITO | DINHEIRO | CARTAO_CREDITO | VALE_BENEFICIO | META
  credit_card_id   TEXT DEFAULT '',
  amount           REAL NOT NULL,
  date             TEXT NOT NULL,
  description      TEXT NOT NULL,
  notes            TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'PAGO',  -- PAGO | PENDENTE
  fixed_expense_id TEXT DEFAULT '',
  card_purchase_id TEXT DEFAULT '',
  goal_id          TEXT DEFAULT '',   -- saída paga com o dinheiro de uma meta
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses (date);
CREATE INDEX IF NOT EXISTS idx_expenses_account  ON expenses (bank_account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_card     ON expenses (credit_card_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status   ON expenses (status);
CREATE INDEX IF NOT EXISTS idx_expenses_fixed    ON expenses (fixed_expense_id);
CREATE INDEX IF NOT EXISTS idx_expenses_purchase ON expenses (card_purchase_id);

CREATE TABLE IF NOT EXISTS fixed_expenses (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  category                TEXT NOT NULL,
  default_bank_account_id TEXT DEFAULT '',
  default_payment_method  TEXT NOT NULL,
  default_credit_card_id  TEXT DEFAULT '',
  estimated_amount        REAL NOT NULL DEFAULT 0,
  due_day                 INTEGER NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL DEFAULT 'ATIVA',
  notes                   TEXT DEFAULT '',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Cartões de crédito e benefícios (vale alimentação/refeição/flexível)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cards_benefits (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  card_type       TEXT NOT NULL DEFAULT 'CREDITO',  -- CREDITO | VALE_ALIMENTACAO | VALE_REFEICAO | BENEFICIO_FLEXIVEL
  "limit"         REAL NOT NULL DEFAULT 0,
  benefit_balance REAL NOT NULL DEFAULT 0,
  closing_day     INTEGER NOT NULL DEFAULT 0,
  due_day         INTEGER NOT NULL DEFAULT 0,
  color           TEXT DEFAULT '#7c3aed',
  status          TEXT NOT NULL DEFAULT 'ATIVO',    -- ATIVO | INATIVO
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_purchases (
  id                  TEXT PRIMARY KEY,
  credit_card_id      TEXT NOT NULL REFERENCES cards_benefits (id) ON DELETE CASCADE,
  category            TEXT NOT NULL,
  description         TEXT NOT NULL,
  total_amount        REAL NOT NULL,
  purchase_date       TEXT NOT NULL,
  installments        INTEGER NOT NULL DEFAULT 1,
  current_installment INTEGER NOT NULL DEFAULT 1,
  notes               TEXT DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_installments (
  id                 TEXT PRIMARY KEY,
  purchase_id        TEXT NOT NULL REFERENCES card_purchases (id) ON DELETE CASCADE,
  credit_card_id     TEXT NOT NULL,
  invoice_month      TEXT NOT NULL,   -- YYYY-MM
  installment_number INTEGER NOT NULL,
  installments_total INTEGER NOT NULL,
  amount             REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ABERTA',  -- ABERTA | PAGA
  paid_at            TEXT DEFAULT '',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installments_card     ON card_installments (credit_card_id, invoice_month);
CREATE INDEX IF NOT EXISTS idx_installments_purchase ON card_installments (purchase_id);

CREATE TABLE IF NOT EXISTS card_invoices (
  id                        TEXT PRIMARY KEY,
  credit_card_id            TEXT NOT NULL,
  reference_month           TEXT NOT NULL,   -- YYYY-MM
  total_amount              REAL NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'ABERTA',  -- ABERTA | PAGA
  paid_at                   TEXT DEFAULT '',
  paid_from_bank_account_id TEXT DEFAULT '',
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (credit_card_id, reference_month)
);

-- ---------------------------------------------------------------------------
-- Investimentos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investments (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,
  institution    TEXT NOT NULL,
  current_amount REAL NOT NULL DEFAULT 0,
  goal_amount    REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ATIVO',
  notes          TEXT DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investment_contributions (
  id              TEXT PRIMARY KEY,
  investment_id   TEXT NOT NULL REFERENCES investments (id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL,
  amount          REAL NOT NULL,
  date            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contributions_date       ON investment_contributions (date);
CREATE INDEX IF NOT EXISTS idx_contributions_investment ON investment_contributions (investment_id);

-- Operações reais da carteira: compra/venda por quantidade e preço. A tabela
-- antiga de aportes continua existindo para preservar o histórico e o vínculo
-- com o saldo bancário; cada nova operação pode apontar para o aporte/resgate
-- financeiro correspondente.
CREATE TABLE IF NOT EXISTS investment_operations (
  id                TEXT PRIMARY KEY,
  investment_id     TEXT NOT NULL REFERENCES investments (id) ON DELETE CASCADE,
  contribution_id   TEXT DEFAULT '',
  operation_type    TEXT NOT NULL, -- COMPRA | VENDA | APORTE | RESGATE | BONIFICACAO | DESDOBRAMENTO
  quantity          REAL NOT NULL DEFAULT 0,
  unit_price        REAL NOT NULL DEFAULT 0,
  exchange_rate     REAL NOT NULL DEFAULT 1,
  fees              REAL NOT NULL DEFAULT 0,
  total_amount      REAL NOT NULL DEFAULT 0,
  date              TEXT NOT NULL,
  bank_account_id   TEXT DEFAULT '',
  institution       TEXT DEFAULT '',
  description       TEXT DEFAULT '',
  notes             TEXT DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_investment_operations_date ON investment_operations (date);
CREATE INDEX IF NOT EXISTS idx_investment_operations_asset ON investment_operations (investment_id, date);

CREATE TABLE IF NOT EXISTS investment_income (
  id                TEXT PRIMARY KEY,
  investment_id     TEXT NOT NULL REFERENCES investments (id) ON DELETE CASCADE,
  income_type       TEXT NOT NULL DEFAULT 'DIVIDENDO',
  ex_date            TEXT DEFAULT '',
  payment_date       TEXT NOT NULL,
  value_per_unit    REAL NOT NULL DEFAULT 0,
  quantity          REAL NOT NULL DEFAULT 0,
  total_amount      REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'RECEBIDO', -- PREVISTO | RECEBIDO
  source            TEXT DEFAULT 'manual',
  external_key      TEXT DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (investment_id, external_key)
);

CREATE INDEX IF NOT EXISTS idx_investment_income_payment ON investment_income (payment_date);

CREATE TABLE IF NOT EXISTS investment_snapshots (
  id                TEXT PRIMARY KEY,
  reference_date    TEXT NOT NULL UNIQUE,
  invested_amount   REAL NOT NULL DEFAULT 0,
  market_value      REAL NOT NULL DEFAULT 0,
  income_total      REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Transferências entre contas
--
-- Não existiam na planilha: mover dinheiro entre contas exigia registrar uma
-- saída falsa e uma entrada falsa, o que inflava os totais do mês. Aqui a
-- transferência é um registro próprio, neutro no resultado do período.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transfers (
  id              TEXT PRIMARY KEY,
  from_account_id TEXT NOT NULL REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  to_account_id   TEXT NOT NULL REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  amount          REAL NOT NULL,
  date            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (from_account_id <> to_account_id)
);

CREATE INDEX IF NOT EXISTS idx_transfers_date ON transfers (date);

-- ---------------------------------------------------------------------------
-- Metas: o objetivo, a caixinha e o plano
--
-- A meta tem três partes. `goals` é o objetivo ("casamento, R$ 20.000").
-- `goal_deposits` é o dinheiro entrando e saindo da caixinha — sai da conta
-- corrente de verdade, como acontece quando você usa a caixinha do banco.
-- `goal_items` é do que a meta é feita: aliança, buffet, local, cada um com
-- seu valor.
--
-- Daí saem os três números que não podem ser confundidos: o quanto você já
-- juntou (todos os depósitos), o quanto já pagou (itens quitados) e o quanto
-- ainda está livre para usar (a diferença).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  target_amount REAL NOT NULL,
  saved_amount  REAL NOT NULL DEFAULT 0,
  target_date   TEXT DEFAULT '',
  investment_id TEXT DEFAULT '',   -- vincula a meta a um investimento existente
  color         TEXT DEFAULT '#d7ff37',
  icon          TEXT DEFAULT '🎯',
  status        TEXT NOT NULL DEFAULT 'ATIVA',  -- ATIVA | CONCLUIDA | ARQUIVADA
  notes         TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_deposits (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  -- De qual conta o dinheiro saiu. Vazio = apenas reservado, sem tirar da
  -- conta (é assim que entram os valores das metas antigas, digitados à mão).
  bank_account_id TEXT DEFAULT '',
  amount          REAL NOT NULL,     -- positivo guarda, negativo retira
  date            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  notes           TEXT DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_deposits_goal ON goal_deposits (goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_deposits_date ON goal_deposits (date);

CREATE TABLE IF NOT EXISTS goal_items (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  planned_amount  REAL NOT NULL DEFAULT 0,
  paid_amount     REAL NOT NULL DEFAULT 0,
  category        TEXT DEFAULT '',
  due_date        TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'PLANEJADO',  -- PLANEJADO | CONTRATADO | PAGO
  paid_source     TEXT DEFAULT '',   -- META (sai da caixinha) | CONTA
  bank_account_id TEXT DEFAULT '',
  paid_date       TEXT DEFAULT '',
  expense_id      TEXT DEFAULT '',   -- a saída gerada ao marcar como pago
  notes           TEXT DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_items_goal ON goal_items (goal_id, position);

-- ---------------------------------------------------------------------------
-- Orçamentos por categoria
--
-- Na planilha isto vivia no localStorage do navegador — sumia ao trocar de
-- máquina e não entrava no backup. Agora é tabela, e viaja junto no export.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS budgets (
  id              TEXT PRIMARY KEY,
  category        TEXT NOT NULL,
  amount          REAL NOT NULL DEFAULT 0,
  reference_month TEXT DEFAULT '',   -- vazio = vale para todos os meses
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (category, reference_month)
);

-- ---------------------------------------------------------------------------
-- Anexos (comprovantes, notas fiscais)
--
-- O arquivo é copiado para <userData>/anexos/ e aqui guardamos só o caminho
-- relativo, para que o backup do banco e a pasta de anexos andem juntos.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,   -- expense | income | invoice | contribution | transfer
  entity_id   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,   -- relativo à pasta de anexos
  mime_type   TEXT DEFAULT '',
  size_bytes  INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Memória de categorias
--
-- Cada vez que você corrige a categoria de um lançamento, o app grava aqui a
-- associação "este termo → esta categoria". Na próxima vez ele acerta sozinho,
-- sem consultar IA nenhuma. É o que faz o app melhorar com o uso.
--
-- `hits` conta quantas vezes a regra foi aplicada — regras muito usadas ganham
-- prioridade, e regras nunca usadas podem ser limpas.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS category_rules (
  id          TEXT PRIMARY KEY,
  term        TEXT NOT NULL,             -- trecho normalizado buscado na descrição
  category    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'variableExpense',  -- income | variableExpense
  match_type  TEXT NOT NULL DEFAULT 'contains',         -- contains | exact
  source      TEXT NOT NULL DEFAULT 'user',             -- user | builtin | ai
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (term, kind)
);

CREATE INDEX IF NOT EXISTS idx_category_rules_term ON category_rules (term);

-- ---------------------------------------------------------------------------
-- Histórico de atividades
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id   TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activities_created ON activities (created_at DESC);

-- ---------------------------------------------------------------------------
-- Importações em lote
--
-- Cada importação guarda o que criou, para poder ser desfeita. Sem isto, um
-- lote de 400 lançamentos que entrou na conta errada só se resolvia
-- restaurando um backup — e junto com ele voltava tudo o que veio depois.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS import_batches (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  files       TEXT NOT NULL DEFAULT '',
  period      TEXT NOT NULL DEFAULT '',
  entries     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL DEFAULT '{}',   -- o que criar/alterou, em JSON
  status      TEXT NOT NULL DEFAULT 'ATIVO' -- ATIVO | DESFEITO
);

CREATE INDEX IF NOT EXISTS idx_import_batches_created ON import_batches (created_at DESC);
