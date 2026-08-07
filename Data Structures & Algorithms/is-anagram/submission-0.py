class Solution:
    def isAnagram(self, s: str, t: str) -> bool:
        A = {}
        B = {}

        for c in s:
            if c not in A:
                A[c] = 0
            A[c] += 1
        for c in t:
            if c not in B:
                B[c] = 0
            B[c] += 1

        if A != B:
            return False
        return True