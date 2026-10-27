<?php
declare(strict_types=1);

namespace Tally;

function formatCents(int $cents): string
{
    return '$' . number_format($cents / 100, 2);
}

function parseCents(string $text): int
{
    return (int) round(((float) $text) * 100);
}

function renderInvoice(Cart $cart): string
{
    $lines = [];
    foreach ($cart->items() as $item) {
        $lines[] = sprintf(
            '%-12s %3d x %9s = %10s',
            $item['sku'],
            $item['qty'],
            formatCents($item['cents']),
            formatCents($item['cents'] * $item['qty'])
        );
    }
    $totals = $cart->totals();
    $lines[] = str_repeat('-', 41);
    $lines[] = sprintf('%-30s %10s', 'Subtotal', formatCents($totals['subtotal']));
    if ($totals['discount'] > 0) {
        $lines[] = sprintf('%-30s %10s', 'Discount', '-' . formatCents($totals['discount']));
    }
    $lines[] = sprintf('%-30s %10s', 'Tax', formatCents($totals['tax']));
    $lines[] = sprintf('%-30s %10s', 'Total', formatCents($totals['total']));
    return implode("\n", $lines) . "\n";
}
