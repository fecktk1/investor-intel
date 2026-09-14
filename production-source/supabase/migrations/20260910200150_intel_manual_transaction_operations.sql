-- Manual trades have no chain signature. Distinct authored operations must not
-- collide merely because their asset, direction and type match. Imported rows
-- retain their existing signature/hash deduplication. A stable row UUID also
-- makes a retried manual insert return its original recorded transaction.
DROP INDEX public.ipt_dedupe;
CREATE UNIQUE INDEX ipt_dedupe ON public.investor_portfolio_transactions (
 source_id,
 COALESCE(external_tx_signature, external_tx_hash, raw_metadata->>'manual_operation_id', ''),
 COALESCE(normalized_symbol, asset_symbol, ''),
 COALESCE(direction, ''),
 transaction_type
);
