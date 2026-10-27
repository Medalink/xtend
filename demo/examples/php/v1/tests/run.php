<?php
declare(strict_types=1);

require __DIR__ . '/../src/Cart.php';
require __DIR__ . '/../src/Invoice.php';

use Tally\Cart;

$failures = 0;
function check(string $name, bool $ok): void
{
    global $failures;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n";
    if (!$ok) {
        $failures++;
    }
}

$cart = new Cart();
$cart->add('pen', 1.50, 4);
$cart->add('book', 12.00);
check('subtotal', $cart->subtotal() === 18.0);
check('tax', $cart->tax() === 1.44);
check('total', $cart->total() === 19.44);

$threw = false;
try {
    $cart->add('bad', -1.0);
} catch (InvalidArgumentException) {
    $threw = true;
}
check('rejects negative price', $threw);

$text = Tally\formatInvoice($cart);
check('invoice lists items', str_contains($text, 'pen') && str_contains($text, '$6.00'));
check('invoice shows total', str_contains($text, '$19.44'));

$out = shell_exec('php ' . escapeshellarg(__DIR__ . '/../bin/cart') . ' pen=1.50*4 book=12');
check('cli prints invoice', is_string($out) && str_contains($out, 'Total') && str_contains($out, '$19.44'));

exit($failures > 0 ? 1 : 0);
