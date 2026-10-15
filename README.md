# Relatório Mensal por Prédio — Carpediem

Relatório de ocupação, ticket médio por noite e receita média por prédio, comparando 2025 x 2026, com uma aba por categoria/prédio.

- Acesso restrito a e-mails `@carpediemhomes.com.br` via Supabase Auth (login com e-mail e senha existentes no projeto Supabase da Carpediem).
- Dados: a página lê o último snapshot salvo (`public.pricing_relatorio_predios_get()`, tabela `pricing_relatorio_predios_cache`) e o botão "Atualizar dados" recalcula a partir das reservas (`public.pricing_relatorio_predios_refresh()`). Funções `security definer`, só e-mails @carpediemhomes.com.br. O cálculo das métricas é no navegador (`report.js`).
- Anos comparados = ano anterior x ano atual (fuso America/Recife); a Visão Geral consolida só meses fechados.
- Mapeamento nome do anúncio → prédio fica no SQL da RPC (`CASE ... ILIKE`). Prédio novo = adicionar uma linha lá.
- Publicado via GitHub Pages: https://leticiasilva21.github.io/relatorio-predios/
- Pensado para ser embutido via `<iframe>` no Jestor.
