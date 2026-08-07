class Solution:
    def topKFrequent(self, nums: List[int], k: int) -> List[int]:
        m = {}

        for n in nums:
            if n not in m:
                m[n] = 1
            else:
                m[n]+=1
        
        sols = list(m.items())
        sols.sort(key=lambda item: item[1])

        sol = []

        for i in range(k):
            print(sols[len(sols)-i-1])
            sol.append(sols[len(sols)-i-1][0])

        return sol