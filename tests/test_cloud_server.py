import sys
from pathlib import Path
import json
import os
import unittest
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'cloud'))
import index as api

TOKEN = 'test-only-' + 'a' * 40
KEY = api.PREFIX + '8000000000000-' + 'a' * 36 + '-' + 'b' * 36 + '.json'
CONTEXT = SimpleNamespace(credentials=SimpleNamespace(access_key_id='testid', access_key_secret='testsecret', security_token='testtoken'))

def event(body, token=TOKEN):
    return json.dumps({'headers': {'Authorization': 'Bearer ' + token}, 'requestContext': {'http': {'method': 'POST'}}, 'body': json.dumps(body)})

class CloudServerTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'BACKUP_TOKEN': TOKEN})
        self.env.start()
    def tearDown(self):
        self.env.stop()
    def test_v4_signature_verified_against_official_sdk(self):
        headers = {'content-disposition': 'attachment', 'content-length': '3', 'content-md5': 'ICy5YqxZB1uWSwcVLSNLcA==', 'content-type': 'text/plain'}
        signed, _ = api.signed_headers('PUT', 'exampleobject', {}, headers, ('LTAI****************', 'yourAccessKeySecret', ''),
                                     timestamp='20250411T064124Z', bucket='examplebucket', region='cn-hangzhou', additional='content-disposition;content-length')
        # SDK v2 reproduces this value for the documented input. The web page's
        # final signature uses a different derived key than its stated secret.
        self.assertTrue(signed['authorization'].endswith('Signature=d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097'))
    def test_unauthorized_request_never_reaches_oss(self):
        with patch.object(api, 'oss') as oss:
            r = api.handler(event({'action': 'list'}, 'wrong'), CONTEXT)
            self.assertEqual(r['statusCode'], 401)
            oss.assert_not_called()
    def test_sts_list_and_put_include_token_and_overwrite_protection(self):
        signed, query = api.signed_headers('GET', '', {'prefix': api.PREFIX, 'marker': '', 'max-keys': '50', 'encoding-type': 'url'}, {},
                                          ('id', 'testsecret', 'testtoken'), timestamp='20250411T064124Z')
        self.assertIn('&marker&', query)
        self.assertEqual(signed['x-oss-security-token'], 'testtoken')
        signed, _ = api.signed_headers('PUT', api.PREFIX + 'abc.json', {},
                                      {'content-type': 'application/json; charset=utf-8', 'content-md5': 'testmd5', 'x-oss-forbid-overwrite': 'true'},
                                      ('id', 'testsecret', 'testtoken'), timestamp='20250411T064124Z')
        self.assertEqual(signed['x-oss-forbid-overwrite'], 'true')
    def test_missing_role_is_configuration_error(self):
        with patch.dict(os.environ, {'ALIBABA_CLOUD_ACCESS_KEY_ID': '', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET': '', 'ALIBABA_CLOUD_SECURITY_TOKEN': ''}):
            self.assertEqual(api.handler(event({'action': 'list'}), None)['statusCode'], 503)
    def test_scope_rejects_paths_and_delete(self):
        with patch.object(api, 'oss') as oss:
            for key in ['index.html', api.PREFIX + '../../index.html', 'prompt-box-backups-other/test.json']:
                self.assertEqual(api.handler(event({'action': 'get', 'key': key}), CONTEXT)['statusCode'], 400)
            self.assertEqual(api.handler(event({'action': 'delete', 'key': KEY}), CONTEXT)['statusCode'], 400)
            oss.assert_not_called()
    def test_confirmed_delete_is_scoped_and_authorized(self):
        with patch.object(api, 'oss', return_value=b'') as oss:
            for key in ['index.html', api.PREFIX, api.PREFIX + '../file.json', 'prompt-box-backups/file.json']:
                self.assertEqual(api.handler(event({'action': 'delete', 'key': key, 'confirmed': True}), CONTEXT)['statusCode'], 400)
            self.assertEqual(api.handler(event({'action': 'delete', 'key': KEY, 'confirmed': True}, 'wrong'), CONTEXT)['statusCode'], 401)
            oss.assert_not_called()
            result = api.handler(event({'action': 'delete', 'key': KEY, 'confirmed': True}), CONTEXT)
            self.assertEqual(result['statusCode'], 200)
            self.assertEqual(json.loads(result['body'])['key'], KEY)
            oss.assert_called_once_with('DELETE', KEY, ('testid', 'testsecret', 'testtoken'))
    def test_delete_failure_does_not_report_success(self):
        with patch.object(api, 'oss', side_effect=api.CloudError('DELETE_PERMISSION', 403)):
            result = api.handler(event({'action': 'delete', 'key': KEY, 'confirmed': True}), CONTEXT)
            self.assertEqual(result['statusCode'], 403)
            self.assertFalse(json.loads(result['body'])['ok'])
    def test_put_keeps_exact_json_and_note(self):
        raw = json.dumps({'app': 'prompt-library', 'version': 2, 'prompts': [{'notes': '面膜盒子三视图'}], 'categories': [], 'drafts': []}, ensure_ascii=False)
        with patch.object(api, 'oss', return_value=b'') as oss:
            r = api.handler(event({'action': 'put', 'key': KEY, 'raw': raw}), CONTEXT)
            self.assertEqual(r['statusCode'], 200)
            self.assertEqual(oss.call_args.kwargs['data'], raw.encode())
            self.assertEqual(json.loads(r['body'])['sha256'], api.hashlib.sha256(raw.encode()).hexdigest())
    def test_identical_retry_accepted_but_different_content_rejected(self):
        raw = json.dumps({'app': 'prompt-library', 'version': 2, 'prompts': [], 'categories': [], 'drafts': []})
        for previous, status in [(raw.encode(), 200), (b'different', 409)]:
            with patch.object(api, 'oss', side_effect=[api.CloudError('CONFLICT', 409), previous]):
                self.assertEqual(api.handler(event({'action': 'put', 'key': KEY, 'raw': raw}), CONTEXT)['statusCode'], status)
    def test_list_decodes_xml_and_passes_prefix_and_pagination(self):
        xml = f'<ListBucketResult><IsTruncated>true</IsTruncated><NextMarker>{KEY}</NextMarker><Contents><Key>{KEY}</Key><LastModified>2026-10-09T10:00:00Z</LastModified><Size>42</Size></Contents></ListBucketResult>'.encode()
        with patch.object(api, 'oss', return_value=xml) as oss:
            r = api.list_backups(('id', 'secret', 'token'))
            self.assertEqual(r['items'][0]['size'], 42)
            self.assertEqual(r['nextMarker'], KEY)
            self.assertEqual(oss.call_args.args[3]['prefix'], api.PREFIX)
    def test_bad_payload_returns_safe_error(self):
        with patch.object(api, 'oss') as oss:
            self.assertEqual(api.handler(event({'action': 'put', 'key': KEY, 'raw': 'no json'}), CONTEXT)['statusCode'], 400)
            oss.assert_not_called()
    def test_policy_delete_only_allows_snapshot_directory(self):
        policy = json.loads((Path(__file__).resolve().parents[1] / 'cloud/ram-policy.json').read_text())
        self.assertEqual(policy['Statement'][1]['Action'], ['oss:GetObject', 'oss:PutObject'])
        self.assertEqual(policy['Statement'][1]['Resource'], ['acs:oss:*:*:your-backup-bucket/prompt-box-backups/*'])
        self.assertEqual(policy['Statement'][0]['Condition']['StringLike']['oss:Prefix'], ['prompt-box-backups/*'])
        self.assertEqual(policy['Statement'][2]['Action'], ['oss:DeleteObject'])
        self.assertEqual(policy['Statement'][2]['Resource'], ['acs:oss:*:*:your-backup-bucket/prompt-box-backups/v1/*'])

if __name__ == '__main__':
    unittest.main()
