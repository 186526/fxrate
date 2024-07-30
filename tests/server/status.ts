import { Instance } from '../../src/index';
import axios from 'axios';
import test from 'tape';

test('GET /info', async (t) => {
    await Instance;
    const req = await axios.get('http://127.0.0.1:8080/info');
    if (req.data.status === 'ok') {
        t.pass('Status OK');
        t.end();
    } else {
        t.fail('Status not OK');
        t.end();
    }
});

test.onFinish(() => {
    process.exit(0);
});
