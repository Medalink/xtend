<?php
declare(strict_types=1);

namespace Tally;

function formatMoney(float $amount): string
{
    return '$' . number_format($amount, 2);
}

function formatInvoice(Cart $cart): string
{
    $lines = [];
    foreach ($cart->items() as $item) {
        $lines[] = sprintf(
            '%-12s %3d x %9s = %10s',
            $item['sku'],
            $item['qty'],
            formatMoney($item['price']),
            formatMoney($item['price'] * $item['qty'])
        );
    }
    $lines[] = str_repeat('-', 41);
    $lines[] = sprintf('%-30s %10s', 'Subtotal', formatMoney($cart->subtotal()));
    $lines[] = sprintf('%-30s %10s', 'Tax', formatMoney($cart->tax()));
    $lines[] = sprintf('%-30s %10s', 'Total', formatMoney($cart->total()));
    return implode("\n", $lines) . "\n";
}
