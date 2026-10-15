# Relatório Mensal por Prédio — Carpediem

Relatório de ocupação, ticket médio por noite e receita média por prédio, comparando 2025 x 2026, com uma aba por categoria/prédio.

- Acesso restrito a e-mails `@carpediemhomes.com.br` via Supabase Auth (login com e-mail e senha existentes no projeto Supabase da Carpediem).
- Dados ao vivo: após o login a página chama a RPC `public.pricing_relatorio_predios_json()` (Supabase, `security definer`, só e-mails @carpediemhomes.com.br) e calcula tudo no navegador (`report.js`). Não precisa regenerar nada.
- Anos comparados = ano anterior x ano atual (fuso America/Recife); a Visão Geral consolida só meses fechados.
- Mapeamento nome do anúncio → prédio fica no SQL da RPC (`CASE ... ILIKE`). Prédio novo = adicionar uma linha lá.
- Publicado via GitHub Pages: https://leticiasilva21.github.io/relatorio-predios/
- Pensado para ser embutido via `<iframe>` no Jestor.
