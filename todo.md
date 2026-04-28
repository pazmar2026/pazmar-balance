
## Fase 2 — Propagação Automática de Saldo Manhã → Tarde

- [ ] Quando a Gerência insere o Bancário da Manhã, esse valor torna-se automaticamente o Inicial da Gerência para a Tarde
- [ ] O campo Inicial da Gerência na Tarde deve aparecer pré-preenchido e bloqueado (só leitura) se o Bancário da Manhã já foi inserido
- [ ] A Gerência pode ainda substituir o valor se necessário (ex: transferência entre turnos)
- [ ] Testar o fluxo completo manhã → tarde

## Fase 5 — Localizações e Gestores Intermédios

- [ ] Adicionar coluna `location` e `zone_manager_id` à tabela `agencies` na BD
- [ ] Atualizar agências: P1, P3, P4, P5 → Lobito; P2, P6 → Benguela
- [ ] Criar 2 perfis de gestor intermédio (Gestor Lobito + Gestor Benguela) com PIN
- [ ] Gestor intermédio vê apenas as agências da sua zona
- [ ] Atualizar dashboard para agrupar agências por zona (Lobito / Benguela)
- [ ] Atualizar formulário de nova agência com campo de localização
- [ ] Testar fluxo completo com gestores intermédios

## Fase 6 — Remoção de Gestores de Zona e Aba Gato

- [ ] Remover os 2 perfis de gestores de zona da base de dados
- [ ] Remover lógica de zone_manager do servidor e frontend
- [ ] Manter agrupamento por zona no dashboard (apenas visual)
- [ ] Criar tabela `gatos` na BD (id, agency_id, user_id, date, shift, amount, note, created_at)
- [ ] Criar rota API POST /api/gatos — registar gato automaticamente quando diferença < 0
- [ ] Criar rota API GET /api/gatos — listar gatos com filtros (data, agência, mês)
- [ ] Criar rota API GET /api/gatos/monthly — resumo mensal por agente e agência
- [ ] Criar aba "Gato" no dashboard da Gerência
- [ ] Mostrar lista de gatos do dia com agência, turno, agente e valor
- [ ] Mostrar acumulado do mês por agência
- [ ] Mostrar acumulado do mês por agente
- [ ] Registar gato automaticamente quando a diferença for negativa (dinheiro a faltar)
- [ ] Testar o fluxo completo

## Novas Funcionalidades (Abril 2026)

- [ ] Acesso directo por URL: ?u=<userId> pré-selecciona utilizador no ecrã de login
- [ ] Acesso directo por URL: mostrar apenas teclado PIN quando userId está na URL
- [ ] Validação diária pelo gerente: tabela daily_validations na BD
- [ ] Validação diária: API POST /api/daily-validation/:date
- [ ] Validação diária: API GET /api/daily-validation/:date
- [ ] Validação diária: botão "Validar Dia" no dashboard da Gerência
- [ ] Validação diária: modal de confirmação com resumo do dia
- [ ] Validação diária: indicador visual de dia validado no dashboard
- [ ] Validação diária: bloquear edições após validação
- [ ] Validação diária: histórico de validações na aba Definições

## Contabilidade dos Depósitos (Abril 2026)

- [ ] Nova aba "Depósitos" no dashboard da Gerência
- [ ] Tabela por agência: saldo físico manhã + saldo físico tarde = total a depositar
- [ ] Total geral de todas as agências
- [ ] Navegação de data (igual ao dashboard)
- [ ] Botão de partilha via WhatsApp do resumo de depósitos
- [ ] Endpoint API GET /api/records/deposits/:date

